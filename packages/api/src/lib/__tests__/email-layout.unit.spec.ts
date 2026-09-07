import { escapeHtml, formatDate, formatMoney, renderEmail } from "../email-layout"

/**
 * These three helpers back every transactional email, and until now none was tested
 * directly — `formatMoney` only through a `/€|EUR/` assertion in the order-confirmation
 * spec, which passes whether the amount renders as €20.00 or €2,000.00, and `formatDate`
 * not at all.
 */

describe("escapeHtml", () => {
  it("neutralises every character that can break out of markup", () => {
    expect(escapeHtml(`<script>"x"&'y'</script>`)).toBe(
      "&lt;script&gt;&quot;x&quot;&amp;&#39;y&#39;&lt;/script&gt;"
    )
  })

  it("escapes the ampersand first, so escapes do not escape each other", () => {
    // "&lt;" must not come back out as "&amp;lt;" — order matters and is easy to break.
    expect(escapeHtml("&")).toBe("&amp;")
    expect(escapeHtml("<")).toBe("&lt;")
    expect(escapeHtml("&<")).toBe("&amp;&lt;")
  })
})

describe("formatMoney", () => {
  it("treats the amount as the currency's major unit", () => {
    // The regression this guards: someone "corrects" the function by dividing by 100,
    // because Stripe and Medusa v1 both use minor units. Medusa v2 does not — seed.ts
    // writes `amount: 10` for a $10 shipping option.
    expect(formatMoney(10, "usd")).toMatch(/10\.00/)
    expect(formatMoney(10, "usd")).not.toMatch(/0\.10/)
  })

  it("follows the currency for decimals rather than assuming two", () => {
    // JPY has no minor unit at all, which is the case a /100 would get wrong twice.
    expect(formatMoney(2000, "jpy")).not.toMatch(/2,000\.00/)
    expect(formatMoney(2000, "jpy")).toMatch(/2,000/)
  })

  it("accepts a lowercase currency code, which is how Medusa stores it", () => {
    expect(formatMoney(10, "eur")).toEqual(formatMoney(10, "EUR"))
  })

  it("still produces something legible for an unknown currency", () => {
    // A bad currency code must not cost the customer their receipt.
    expect(formatMoney(10, "not-a-currency")).toBe("10.00 NOT-A-CURRENCY")
  })
})

describe("formatDate", () => {
  it("formats in UTC so the day cannot silently shift", () => {
    // Late-evening UTC is the next day in some zones and the previous day in others;
    // pinning to UTC is what makes this assertion stable wherever it runs.
    expect(formatDate("2026-09-11T23:30:00Z")).toBe("11 September 2026")
  })

  it("accepts a Date as well as a string", () => {
    expect(formatDate(new Date("2026-09-11T00:00:00Z"))).toBe("11 September 2026")
  })

  it("returns undefined rather than 'Invalid Date' for junk or nothing", () => {
    // The callers render this straight into an email, so a bad value must disappear
    // rather than print.
    expect(formatDate(undefined)).toBeUndefined()
    expect(formatDate("")).toBeUndefined()
    expect(formatDate("not a date")).toBeUndefined()
  })
})

describe("renderEmail", () => {
  it("escapes the heading, the cta and the note, but trusts bodyHtml", () => {
    const html = renderEmail({
      heading: "<b>hi</b>",
      // Documented as already-escaped markup: callers escape their own values.
      bodyHtml: "<p>kept</p>",
      cta: { label: "<b>go</b>", url: 'https://x.test/?a=1&b="2"' },
      note: "<i>note</i>",
      footer: "<i>footer</i>",
    })

    expect(html).toContain("&lt;b&gt;hi&lt;/b&gt;")
    expect(html).toContain("<p>kept</p>")
    expect(html).toContain("&lt;b&gt;go&lt;/b&gt;")
    expect(html).toContain("&amp;b=&quot;2&quot;")
    expect(html).toContain("&lt;i&gt;note&lt;/i&gt;")
    expect(html).toContain("&lt;i&gt;footer&lt;/i&gt;")
  })

  it("omits the optional blocks entirely rather than rendering empties", () => {
    const html = renderEmail({ heading: "Hi", bodyHtml: "Body" })

    expect(html).not.toContain("undefined")
    expect(html).not.toContain("<a href")
  })
})
