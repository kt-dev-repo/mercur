import { buildInvitationHtml } from "../send-member-invite-email"

// The address is whatever the operator typed into the invite form and the URL's origin
// comes from MERCUR_VENDOR_URL, so neither is trusted markup. These assert the escaping
// rather than the layout: the surrounding template is presentation and will change.
describe("buildInvitationHtml", () => {
  it("escapes markup in the address instead of emitting it", () => {
    const html = buildInvitationHtml(`"><script>alert(1)</script>@example.com`)

    expect(html).not.toContain("<script>")
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;")
  })

  it("escapes the registration URL so it cannot break out of the href", () => {
    const html = buildInvitationHtml(
      "seller@example.com",
      `https://vendor.example.com/invite?token=abc" onmouseover="alert(1)`
    )

    expect(html).not.toContain(`onmouseover="alert(1)"`)
    expect(html).toContain("&quot; onmouseover=&quot;alert(1)")
  })

  it("escapes ampersands once, not twice", () => {
    const html = buildInvitationHtml("a&b@example.com")

    expect(html).toContain("a&amp;b@example.com")
    expect(html).not.toContain("&amp;amp;")
  })

  it("leaves an ordinary address and URL readable", () => {
    const html = buildInvitationHtml(
      "seller@example.com",
      "https://vendor.example.com/invite?token=abc"
    )

    expect(html).toContain("<strong>seller@example.com</strong>")
    expect(html).toContain(`href="https://vendor.example.com/invite?token=abc"`)
  })

  it("omits the call to action when there is no registration URL", () => {
    const html = buildInvitationHtml("seller@example.com")

    expect(html).not.toContain("Create your seller account")
  })
})
