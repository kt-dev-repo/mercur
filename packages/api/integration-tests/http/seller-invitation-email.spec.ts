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

        // The row alone is not enough. createNotifications persists the notification
        // before handing it to a provider, so with no provider configured the row still
        // appears and every assertion above passes while nothing is delivered — the exact
        // silent failure this whole change exists to fix. `status` is what distinguishes
        // "sent" from "recorded": it is 'failure' when no provider could take it.
        expect(sent![0].status).toEqual("success")

        // Proves the seller lookup in the subscriber actually resolves. The store name
        // fails soft — the email still sends without it — so without an assertion a
        // broken lookup would leave every test green and every invitation anonymous.
        // `content` is not persisted by the notification module, but `data` is.
        expect(sent![0].data).toMatchObject({ seller_name: "Invite Store" })

        // A redelivered event must not mail the person twice. The column is unique, so
        // this is what makes the second insert impossible rather than merely unlikely.
        // Cast: the column exists on the model and createNotifications accepts it, but
        // NotificationDTO does not surface it.
        expect((sent![0] as { idempotency_key?: string }).idempotency_key).toEqual(
          `member-invite-${res.data.member_invite.id}`
        )
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
