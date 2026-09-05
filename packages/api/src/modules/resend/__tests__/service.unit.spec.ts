import { ResendNotificationService } from "../service"

const logger = { info: jest.fn(), error: jest.fn(), warn: jest.fn() } as any

const service = (overrides: Record<string, unknown> = {}) =>
  new ResendNotificationService(
    { logger },
    {
      api_key: "re_test",
      from: "marketplace@example.com",
      base_url: "https://resend.test",
      retry_base_delay_ms: 0,
      ...overrides,
    } as any
  )

// The exact shape Mercur's sendSellerInvitationEmailStep produces: it renders the body
// itself and passes template/data alongside for providers that would rather not.
const invitation = {
  to: "seller@example.com",
  channel: "email",
  template: "newSellerInvitation",
  data: { email: "seller@example.com", registration_url: "https://example.com/join" },
  content: {
    subject: "You've been invited to sell on our marketplace",
    html: "<html><body>Come and sell</body></html>",
  },
} as any

const okResponse = (body: unknown = { id: "email_123" }) =>
  ({
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  }) as unknown as Response

const failResponse = (status: number, headers: Record<string, string> = {}) =>
  ({
    ok: false,
    status,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    json: async () => ({}),
    text: async () => `{"message":"status ${status}"}`,
  }) as unknown as Response

describe("ResendNotificationService", () => {
  let fetchMock: jest.Mock

  beforeEach(() => {
    fetchMock = jest.fn()
    global.fetch = fetchMock as any
    logger.error.mockReset()
    logger.info.mockReset()
  })

  const bodyOf = () => JSON.parse(fetchMock.mock.calls[0][1].body)

  it("posts the subject and body Mercur rendered, to the right address", async () => {
    fetchMock.mockResolvedValue(okResponse())

    const result = await service().send(invitation)

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toEqual("https://resend.test/emails")
    expect(init.method).toEqual("POST")
    expect(init.headers.Authorization).toEqual("Bearer re_test")
    expect(bodyOf()).toMatchObject({
      from: "marketplace@example.com",
      to: ["seller@example.com"],
      subject: "You've been invited to sell on our marketplace",
      html: "<html><body>Come and sell</body></html>",
    })
    expect(result).toEqual({ id: "email_123" })
  })

  // The REST API uses snake_case; the SDK's camelCase `replyTo` is silently ignored.
  it("sends reply_to in snake_case, and only when configured", async () => {
    fetchMock.mockResolvedValue(okResponse())
    await service().send(invitation)
    expect(bodyOf()).not.toHaveProperty("reply_to")

    fetchMock.mockClear()
    fetchMock.mockResolvedValue(okResponse())
    await service({ reply_to: "support@example.com" }).send(invitation)
    expect(bodyOf()).toMatchObject({ reply_to: "support@example.com" })
    expect(bodyOf()).not.toHaveProperty("replyTo")
  })

  // A blank email is worse than no email: the recipient gets something useless and every
  // layer above reports success, so the only symptom is a confused person.
  it("refuses to send when the body is missing rather than sending an empty email", async () => {
    const noBody = { ...invitation, content: { subject: "Hello", html: undefined } }

    await expect(service().send(noBody as any)).rejects.toThrow(/html body/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("refuses when there is no recipient", async () => {
    await expect(service().send({ ...invitation, to: "" } as any)).rejects.toThrow(
      /no recipient/
    )
    expect(fetchMock).not.toHaveBeenCalled()
  })

  // fetch resolves normally for a 4xx, so without an explicit check a rejected send —
  // an unverified From address being the common case — is recorded as delivered.
  it("treats a non-2xx response as a failure, not a success", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 403,
      text: async () => '{"message":"The from address is not verified"}',
      json: async () => ({ message: "The from address is not verified" }),
    } as unknown as Response)

    await expect(service().send(invitation)).rejects.toThrow(/not verified/)
    expect(logger.error).toHaveBeenCalled()
  })

  it("surfaces a transport failure rather than reporting success", async () => {
    fetchMock.mockRejectedValue(new Error("The operation was aborted due to timeout"))

    await expect(service().send(invitation)).rejects.toThrow(/Could not reach Resend/)
    expect(logger.error).toHaveBeenCalled()
  })

  it("gives the request a deadline so a hung API cannot pin the handler open", async () => {
    fetchMock.mockResolvedValue(okResponse())
    await service().send(invitation)
    expect(fetchMock.mock.calls[0][1].signal).toBeDefined()
  })


  // Resend's free tier allows about two requests a second, so inviting a team walks
  // straight into a 429. A 429 nobody retries is an invitation silently never sent.
  describe("retrying", () => {
    it("retries a 429 and succeeds", async () => {
      fetchMock
        .mockResolvedValueOnce(failResponse(429))
        .mockResolvedValueOnce(okResponse())

      const result = await service().send(invitation)

      expect(fetchMock).toHaveBeenCalledTimes(2)
      expect(result).toEqual({ id: "email_123" })
    })

    it("retries a 500 and gives up after three attempts", async () => {
      fetchMock.mockResolvedValue(failResponse(500))

      await expect(service().send(invitation)).rejects.toThrow(/Resend rejected/)
      expect(fetchMock).toHaveBeenCalledTimes(3)
    })

    it("retries a transport failure", async () => {
      fetchMock
        .mockRejectedValueOnce(new Error("socket hang up"))
        .mockResolvedValueOnce(okResponse())

      await expect(service().send(invitation)).resolves.toEqual({ id: "email_123" })
      expect(fetchMock).toHaveBeenCalledTimes(2)
    })

    // A 4xx is a rejection that will reject again — retrying it just delays the error.
    it("does not retry a 403", async () => {
      fetchMock.mockResolvedValue(failResponse(403))

      await expect(service().send(invitation)).rejects.toThrow(/Resend rejected/)
      expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    it("waits for Retry-After when Resend names a delay", async () => {
      jest.spyOn(global, "setTimeout")
      fetchMock
        .mockResolvedValueOnce(failResponse(429, { "retry-after": "2" }))
        .mockResolvedValueOnce(okResponse())

      await service({ retry_base_delay_ms: 999 }).send(invitation)

      expect(setTimeout).toHaveBeenCalledWith(expect.any(Function), 2000)
      ;(setTimeout as unknown as jest.SpyInstance).mockRestore()
    })
  })

  // A redelivered event must not mail the person twice; Resend dedupes on this key.
  it("passes an idempotency key through when the caller supplies one", async () => {
    fetchMock.mockResolvedValue(okResponse())

    await service().send({
      ...invitation,
      data: { ...invitation.data, idempotency_key: "member-invite-123" },
    } as any)

    expect(fetchMock.mock.calls[0][1].headers["Idempotency-Key"]).toEqual(
      "member-invite-123"
    )
  })

  it("omits the header when there is no key rather than sending an empty one", async () => {
    fetchMock.mockResolvedValue(okResponse())
    await service().send(invitation)
    expect(fetchMock.mock.calls[0][1].headers).not.toHaveProperty("Idempotency-Key")
  })

  // Every send is logged, so a full address here is a permanent greppable list of who
  // uses this marketplace.
  it("masks the recipient in logs", async () => {
    fetchMock.mockResolvedValue(okResponse())

    await service().send(invitation)

    const logged = logger.info.mock.calls[0][0]
    expect(logged).toContain("s***@example.com")
    expect(logged).not.toContain("seller@example.com")
  })

  describe("validateOptions", () => {
    it("names everything that is missing", () => {
      expect(() => ResendNotificationService.validateOptions({})).toThrow(/api_key/)
      expect(() => ResendNotificationService.validateOptions({})).toThrow(/from/)
      expect(() =>
        ResendNotificationService.validateOptions({ api_key: "re_test" })
      ).toThrow(/from/)
    })

    it("accepts a complete configuration", () => {
      expect(() =>
        ResendNotificationService.validateOptions({ api_key: "re_test", from: "a@b.com" })
      ).not.toThrow()
    })

    // Presence alone lets a malformed From boot clean and fail on the first real send —
    // the "configured but silently broken" state this hook exists to prevent.
    it("rejects a from that is not an address", () => {
      expect(() =>
        ResendNotificationService.validateOptions({ api_key: "re_test", from: "marketplace" })
      ).toThrow(/not an email address/)
    })

    it("accepts the display-name form Resend also takes", () => {
      expect(() =>
        ResendNotificationService.validateOptions({
          api_key: "re_test",
          from: "Our Marketplace <marketplace@example.com>",
        })
      ).not.toThrow()
    })
  })
})
