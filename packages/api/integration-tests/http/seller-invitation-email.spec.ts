import { medusaIntegrationTestRunner } from "@medusajs/test-utils"
import { Modules } from "@medusajs/framework/utils"

jest.setTimeout(5 * 60 * 1000)

const PASSWORD = "supersecret"

/**
 * Inviting a seller must actually send them something.
 *
 * Mercur ships every piece of this except the wiring. `createMemberInvitesWorkflow`
 * creates the invite and emits `member_invite.created`; `sendSellerInvitationEmailStep`
 * knows how to build and send the email; and nothing connects them — the workflow that
 * calls the step is exported and invoked by no route, and no subscriber listens for the
 * event. So an operator invites a seller, the API returns 201, a valid invite exists, and
 * the person is never told. Everything looks like it worked.
 *
 * This asserts the connection exists, using the local notification provider, so it needs
 * no credentials and sends no mail. It would have failed before the subscriber was added,
 * which is the only reason to trust it now.
 *
 * The whole flow lives in one `it` because the runner restores the database between tests.
 */
medusaIntegrationTestRunner({
  inApp: true,
  env: {},
  testSuite: ({ api, getContainer }) => {
    describe("seller invitation email", () => {
      let adminToken: string

      beforeAll(async () => {
        const container = getContainer()
        const auth = container.resolve(Modules.AUTH)
        const userService = container.resolve(Modules.USER)
        const email = "operator@invite.test"

        const reg = await auth.register("emailpass", {
          body: { email, password: PASSWORD },
        })
        const [user] = await userService.createUsers([{ email }])
        await auth.updateAuthIdentities([
          { id: reg.authIdentity!.id, app_metadata: { user_id: user.id } },
        ])
        adminToken = (
          await api.post("/auth/user/emailpass", { email, password: PASSWORD })
        ).data.token
      })

      it("notifies the invited address when an operator invites a member", async () => {
        const container = getContainer()
        const adminHeaders = { headers: { authorization: `Bearer ${adminToken}` } }

        // A seller to invite someone into.
        const ownerEmail = "owner@invite.test"
        const registerToken = (
          await api.post("/auth/member/emailpass/register", {
            email: ownerEmail,
            password: PASSWORD,
          })
        ).data.token

        const sellerId = (
          await api.post(
            "/vendor/sellers",
            {
              name: "Invite Store",
              email: ownerEmail,
              currency_code: "eur",
              member_email: ownerEmail,
            },
            { headers: { authorization: `Bearer ${registerToken}` } }
          )
        ).data.seller.id

        await api.post(`/admin/sellers/${sellerId}/approve`, {}, adminHeaders)

        const invited = "newcolleague@invite.test"
        const res = await api.post(
          `/admin/sellers/${sellerId}/members/invite`,
          // role_id is required by the route's validator, not optional.
          { email: invited, role_id: "role_seller_administration" },
          adminHeaders
        )

        expect(res.status).toEqual(201)
        expect(res.data.member_invite.email).toEqual(invited)

        // The invite is created synchronously; the email goes out on an event, so give
        // the subscriber a moment rather than assuming it has already run.
        const notificationService = container.resolve(Modules.NOTIFICATION)
        const sent = await waitFor(async () => {
          const rows = await notificationService.listNotifications({ to: invited })
          return rows.length ? rows : null
        })

        expect(sent).not.toBeNull()
        expect(sent![0]).toMatchObject({
          to: invited,
          channel: "email",
          template: "newSellerInvitation",
        })
      })

      const waitFor = async <T>(
        check: () => Promise<T | null>,
        attempts = 25
      ): Promise<T | null> => {
        for (let i = 0; i < attempts; i++) {
          const result = await check()
          if (result) {
            return result
          }
          await new Promise((r) => setTimeout(r, 200))
        }
        return null
      }
    })
  },
})
