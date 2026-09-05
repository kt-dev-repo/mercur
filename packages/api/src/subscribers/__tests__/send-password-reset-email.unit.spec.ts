import { buildPasswordResetHtml, buildResetUrl } from "../send-password-reset-email"

// Three audiences are served by three different front ends. Sending a seller to the
// admin panel is a dead end that looks like a broken link, so the routing is asserted
// per actor type rather than left to be discovered in production.
describe("buildResetUrl", () => {
  const env = { ...process.env }

  beforeEach(() => {
    delete process.env.MERCUR_BACKEND_URL
    delete process.env.MERCUR_ADMIN_URL
    delete process.env.MERCUR_VENDOR_URL
    delete process.env.MERCUR_STOREFRONT_URL
  })

  afterAll(() => {
    process.env = env
  })

  it("sends an operator to the admin panel and a seller to the vendor panel", () => {
    process.env.MERCUR_BACKEND_URL = "https://api.example.com"

    expect(buildResetUrl("user", "t")).toContain("https://api.example.com/dashboard/reset-password")
    expect(buildResetUrl("member", "t")).toContain("https://api.example.com/seller/reset-password")
  })

  it("prefers an explicitly configured panel URL over the backend default", () => {
    process.env.MERCUR_BACKEND_URL = "https://api.example.com"
    process.env.MERCUR_VENDOR_URL = "https://sellers.example.com"

    expect(buildResetUrl("member", "t")).toContain("https://sellers.example.com/reset-password")
  })

  it("has no link for a customer until a storefront is configured", () => {
    process.env.MERCUR_BACKEND_URL = "https://api.example.com"

    // The backend serves no storefront, so guessing an origin would produce a link to
    // nowhere. Better to send the email without one.
    expect(buildResetUrl("customer", "t")).toBeUndefined()

    process.env.MERCUR_STOREFRONT_URL = "https://shop.example.com"
    expect(buildResetUrl("customer", "t")).toContain("https://shop.example.com/reset-password")
  })

  it("tolerates a trailing slash rather than emitting a doubled one", () => {
    process.env.MERCUR_STOREFRONT_URL = "https://shop.example.com/"

    expect(buildResetUrl("customer", "t")).toContain("https://shop.example.com/reset-password")
    expect(buildResetUrl("customer", "t")).not.toContain(".com//")
  })

  it("escapes the token into the query string", () => {
    process.env.MERCUR_STOREFRONT_URL = "https://shop.example.com"

    expect(buildResetUrl("customer", "a b&c")).toContain("token=a%20b%26c")
  })
})

describe("buildPasswordResetHtml", () => {
  it("escapes markup in the address instead of emitting it", () => {
    const html = buildPasswordResetHtml(`"><script>alert(1)</script>@example.com`)

    expect(html).not.toContain("<script>")
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;")
  })

  it("escapes the reset URL so it cannot break out of the href", () => {
    const html = buildPasswordResetHtml(
      "user@example.com",
      `https://shop.example.com/reset-password?token=a" onmouseover="alert(1)`
    )

    expect(html).not.toContain(`onmouseover="alert(1)"`)
    expect(html).toContain("&quot; onmouseover=&quot;alert(1)")
  })

  it("states the expiry, because a silently dead link reads as a broken system", () => {
    expect(buildPasswordResetHtml("user@example.com", "https://shop.example.com/r")).toContain(
      "15 minutes"
    )
  })

  it("still explains what to do when no reset page is configured", () => {
    const html = buildPasswordResetHtml("user@example.com")

    expect(html).not.toContain("<a href")
    expect(html).toContain("Contact an administrator")
  })

  it("tells a recipient who did not ask that nothing has changed", () => {
    // This email is the one an account takeover attempt looks like from the outside.
    expect(buildPasswordResetHtml("user@example.com", "https://x/r")).toContain(
      "your password has not changed"
    )
  })
})
