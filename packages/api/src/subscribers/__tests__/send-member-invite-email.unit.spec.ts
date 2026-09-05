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

  // A recipient of an invitation from a marketplace with many sellers cannot tell who is
  // asking unless the store is named — the mail reads like spam.
  it("names the inviting store in the heading and the body", () => {
    const html = buildInvitationHtml(
      "seller@example.com",
      "https://vendor.example.com/invite?token=abc",
      "Nokor Test Store"
    )

    expect(html).toContain("Nokor Test Store has invited you to sell on our marketplace")
    expect(html).toContain("<strong>Nokor Test Store</strong> has invited")
  })

  it("escapes the store name too — it is operator input like the rest", () => {
    const html = buildInvitationHtml(
      "seller@example.com",
      undefined,
      `<script>alert(1)</script>`
    )

    expect(html).not.toContain("<script>")
    expect(html).toContain("&lt;script&gt;")
  })

  it("falls back to the generic wording when the store name is unknown", () => {
    const html = buildInvitationHtml("seller@example.com")

    expect(html).toContain("You've been invited to sell on our marketplace")
  })

  // A link that has quietly expired is worse than one that says when it will.
  it("states the expiry date, in UTC", () => {
    const html = buildInvitationHtml(
      "seller@example.com",
      undefined,
      undefined,
      "2026-09-11T23:47:27.359Z"
    )

    expect(html).toContain("This invitation expires on 11 September 2026")
  })

  it("omits the expiry line rather than printing an invalid date", () => {
    expect(
      buildInvitationHtml("seller@example.com", undefined, undefined, "not-a-date")
    ).not.toContain("expires on")
    expect(buildInvitationHtml("seller@example.com")).not.toContain("expires on")
  })

  it("omits the call to action when there is no registration URL", () => {
    const html = buildInvitationHtml("seller@example.com")

    expect(html).not.toContain("Create your seller account")
  })
})
