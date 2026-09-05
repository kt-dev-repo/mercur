import handler from "../send-password-reset-email"

// The URL building and markup are covered next door. These cover the handler: what it
// sends, what it refuses to send, and — the point of the whole subscriber — that it
// never takes the request down with it when delivery fails.

const makeContainer = (overrides: Record<string, unknown> = {}) => {
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
  const notificationService = {
    createNotifications: jest.fn().mockResolvedValue({}),
    ...(overrides.notificationService as object),
  }
  return {
    logger,
    notificationService,
    container: {
      resolve: (key: string) =>
        key === "logger" ? logger : notificationService,
    },
  }
}

const run = async (data: unknown, c: ReturnType<typeof makeContainer>) =>
  handler({
    event: { data } as never,
    container: c.container as never,
  } as never)

describe("password reset subscriber", () => {
  const OLD_ENV = process.env

  beforeEach(() => {
    process.env = { ...OLD_ENV, MERCUR_BACKEND_URL: "https://api.example.com" }
  })

  afterAll(() => {
    process.env = OLD_ENV
  })

  it("sends a reset email carrying the actor type and a link", async () => {
    const c = makeContainer()
    await run({ entity_id: "a@b.com", actor_type: "user", token: "tok" }, c)

    expect(c.notificationService.createNotifications).toHaveBeenCalledTimes(1)
    const arg = c.notificationService.createNotifications.mock.calls[0][0]
    expect(arg).toMatchObject({ to: "a@b.com", channel: "email", template: "passwordReset" })
    expect(arg.data.reset_url).toContain("/dashboard/reset-password?token=tok")
  })

  it("never puts the raw token in the idempotency key", async () => {
    // The token is a JWT that grants a password reset. The idempotency key is a unique
    // column and turns up in logs and indexes, so it must not carry the credential.
    const c = makeContainer()
    const token = "eyJhbGciOiJIUzI1NiJ9.secret-payload"
    await run({ entity_id: "a@b.com", actor_type: "user", token }, c)

    const arg = c.notificationService.createNotifications.mock.calls[0][0]
    expect(arg.idempotency_key).not.toContain(token)
    expect(arg.idempotency_key).not.toContain("secret-payload")
  })

  it("keys retries together but lets a genuinely new request through", async () => {
    const keyFor = async (token: string) => {
      const c = makeContainer()
      await run({ entity_id: "a@b.com", actor_type: "user", token }, c)
      return c.notificationService.createNotifications.mock.calls[0][0].idempotency_key
    }

    // A redelivered event carries the same token and must not mail twice.
    expect(await keyFor("same")).toEqual(await keyFor("same"))
    // Asking again mints a new token, and that person is waiting for an email.
    expect(await keyFor("first")).not.toEqual(await keyFor("second"))
  })

  it("sends nothing when the event carries no identifier or token", async () => {
    for (const data of [
      {},
      { entity_id: "a@b.com", actor_type: "user" },
      { actor_type: "user", token: "tok" },
    ]) {
      const c = makeContainer()
      await run(data, c)
      expect(c.notificationService.createNotifications).not.toHaveBeenCalled()
    }
  })

  it("does not throw when delivery fails", async () => {
    // The token is already minted and the user can request another. Throwing would fail
    // the event handler without getting anyone their email.
    const c = makeContainer({
      notificationService: {
        createNotifications: jest.fn().mockRejectedValue(new Error("no provider")),
      },
    })

    await expect(
      run({ entity_id: "a@b.com", actor_type: "user", token: "tok" }, c)
    ).resolves.toBeUndefined()
    expect(c.logger.error).toHaveBeenCalled()
  })

  it("says nothing about the address when it fails", async () => {
    // The route answers 201 for unknown addresses so it cannot be used to enumerate
    // accounts. A log line naming the address would leak exactly that, into wherever
    // logs are shipped.
    const c = makeContainer({
      notificationService: {
        createNotifications: jest.fn().mockRejectedValue(new Error("nope")),
      },
    })
    await run({ entity_id: "secret@person.com", actor_type: "user", token: "t" }, c)

    const logged = c.logger.error.mock.calls.flat().join(" ")
    expect(logged).not.toContain("secret@person.com")
  })
})
