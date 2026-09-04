import { ResendNotificationService } from "../service"

// Stand in for the Resend SDK so nothing leaves the machine.
const sendMock = jest.fn()
jest.mock("resend", () => ({
  Resend: jest.fn().mockImplementation(() => ({ emails: { send: sendMock } })),
}))

const logger = { info: jest.fn(), error: jest.fn(), warn: jest.fn() } as any

const service = () =>
  new ResendNotificationService(
    { logger },
    { api_key: "re_test", from: "marketplace@example.com" }
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

describe("ResendNotificationService", () => {
  beforeEach(() => {
    sendMock.mockReset()
    logger.error.mockReset()
  })

  it("sends the subject and body Mercur rendered, to the right address", async () => {
    sendMock.mockResolvedValue({ data: { id: "email_123" }, error: null })

    const result = await service().send(invitation)

    expect(sendMock).toHaveBeenCalledWith(
      expect.objectContaining({
        from: "marketplace@example.com",
        to: ["seller@example.com"],
        subject: "You've been invited to sell on our marketplace",
        html: "<html><body>Come and sell</body></html>",
      })
    )
    expect(result).toEqual({ id: "email_123" })
  })

  it("includes reply_to only when one is configured", async () => {
    sendMock.mockResolvedValue({ data: { id: "e" }, error: null })

    await service().send(invitation)
    expect(sendMock.mock.calls[0][0]).not.toHaveProperty("replyTo")

    sendMock.mockClear()
    await new ResendNotificationService(
      { logger },
      { api_key: "re_test", from: "m@example.com", reply_to: "support@example.com" }
    ).send(invitation)
    expect(sendMock.mock.calls[0][0]).toMatchObject({ replyTo: "support@example.com" })
  })

  // A blank email is worse than no email: the recipient gets something useless and every
  // layer above reports success, so the only symptom is a confused person.
  it("refuses to send when the body is missing rather than sending an empty email", async () => {
    const noBody = { ...invitation, content: { subject: "Hello", html: undefined } }

    await expect(service().send(noBody as any)).rejects.toThrow(/html body/)
    expect(sendMock).not.toHaveBeenCalled()
  })

  it("refuses when there is no recipient", async () => {
    await expect(service().send({ ...invitation, to: "" } as any)).rejects.toThrow(
      /no recipient/
    )
    expect(sendMock).not.toHaveBeenCalled()
  })

  // The SDK reports failures in the response instead of throwing, so without an explicit
  // check a rejected send returns cleanly and the notification is recorded as delivered.
  it("treats an error in the response as a failure, not a success", async () => {
    sendMock.mockResolvedValue({
      data: null,
      error: { message: "The from address is not verified", name: "validation_error" },
    })

    await expect(service().send(invitation)).rejects.toThrow(/not verified/)
    expect(logger.error).toHaveBeenCalled()
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
