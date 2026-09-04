import { ResendNotificationService } from "../service"

const logger = { info: jest.fn(), error: jest.fn(), warn: jest.fn() } as any

const service = (overrides: Record<string, unknown> = {}) =>
  new ResendNotificationService(
    { logger },
    {
      api_key: "re_test",
      from: "marketplace@example.com",
      base_url: "https://resend.test",
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
  })
})
