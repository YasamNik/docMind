# Gmail over OAuth for email intake

Date: 2026-09-19
Feature list item: #18 (Email intake), the Gmail half. The intake spec listed this as a
later change: "Not Gmail OAuth. That is worth doing later through the same Google app as
Drive, and it removes the app password entirely." This is that change.

## Why

Email intake works and the user cannot turn it on. The Email tab asks for an IMAP host, a
port, a mailbox address and an app password, and the app password is the wall: it lives
behind two-step verification, on a page Google keeps moving, under a name that sounds like
something you should not be creating. In the user's words: "i do not understand
instructions, and wondering that the same way as we done gdrive connection, can we do for
email as well using Auth same one preferably", and then, more precisely: "is there a way
like in other services where you asked to connect with google provider and you select
account and authorize connection, that will be the easiest way".

That is exactly what this ships, and it is worth being honest about which part of the
friction is inherent and which part we are removing, because the next person to read this
will want to remove the rest too and cannot.

**Inherent.** A self-hosted app has no DocMind server standing between the user and Google.
"Sign in with Google" on a hosted product works because the company running it holds one
registered OAuth client and its secret. DocMind holds nothing: the only machine in the
story is the user's own, so the Google Cloud app has to be theirs. That first registration
cannot be made to vanish for a self-hosted app, only done once.

**Removed.** They already did it once, for Google Drive. The client id, the secret, the
refresh token and the account email are all sitting in their settings table right now. So
Gmail reuses that app: the same client, the same secret, and, by design decision below, the
same registered redirect URI. What is left on the Google Cloud side is one field, adding
`https://mail.google.com/` to the app's scopes. Everything else is in DocMind: press
Connect Gmail, choose the account, approve, connected. No second app, no second redirect
URI, no consent screen to configure, and no app password, host, port or address to type.

IMAP carries the result. The protocol has an XOAUTH2 mechanism where an access token takes
the password's place, and `imapflow` supports it directly (`auth: { user, accessToken }`),
so the intake pipeline behind it does not change at all: same folders, same Done and Failed
moves, same retries, same attachment handling.

## What the user decided

Asked and answered on 2026-09-19:

- **The app password path stays.** Proton, Fastmail and Outlook are not Google, and IMAP
  with a password is what works for them. A Gmail user never sees those fields once
  connected.
- **Email reuses the client id and secret already saved for Google Drive.** Registering a
  second Google app to read your own mail is precisely the kind of thing that made the
  first setup hard. An override exists for anyone who wants email on a separate app, and it
  doubles as the path for anyone who never set up Drive.
- **Email reuses the redirect URI already registered for Google Drive.** Adding a second
  authorized redirect URI is one more field in a console the user finds hard, for no
  benefit: the state is already signed, so it can carry which connection a callback belongs
  to. Section 2 says how.
- **Gmail's host and port are not settings.** imap.gmail.com and 993 are facts, not
  choices, and a field that can hold only one correct value is a field that can be typed
  wrong.
- **Folder, Done, Failed, poll interval and size cap are untouched.** This is a new way to
  sign in, not a new intake.

## Design

### 1. Two ways to sign in, one pipeline

The loop gains a mode, resolved fresh every cycle the way the credentials already are:

| Mode | When | How it connects |
|------|------|-----------------|
| `gmail` | `email.gmail.refreshToken` and `email.gmail.accountEmail` are both set | imap.gmail.com:993, XOAUTH2 with a fresh access token |
| `password` | no Gmail connection, and host plus password are set | today's behavior, unchanged |
| `unconfigured` | neither | the loop returns without connecting, as today |

**Gmail wins when both are configured.** Connecting an account is a deliberate, recent act;
an app password is usually a leftover from before. The Email tab reinforces this rather
than relying on it: once Gmail is connected the IMAP fields move behind a "Use a different
mailbox provider" disclosure, and a line above them says the app password is not being used
and that disconnecting Gmail brings it back.

Mode resolution is a pure function of the settings values, so it lives in
`email.models.ts` and is unit tested against every combination, including the
half-configured ones.

`email.client.ts` takes one more optional argument. `createImapClient` accepts exactly one
of `password` or `accessToken` and throws a plain AppError if given both or neither, and
passes `auth: { user, accessToken }` instead of `auth: { user, pass }` in the token case.
Nothing else in that file changes: `reasonFor` still rebuilds every error from a handful of
known structured fields, so an access token gets the same guarantee the password has today,
which is that it never reaches a log line, a stack, or an API response.

The token is fetched in the usecase, not in the client, and handed to the client as a
string. The client stays a dumb transport with no knowledge of Google, and a test can
inject a token without injecting an OAuth library.

### 2. One registered redirect URI, and a signed state that says where a callback is going

Google's registered redirect URI is an address it is allowed to send a browser back to. It
is not a statement about what the user was connecting. Today DocMind treats it as both:
`buildOAuthRedirectUri` produces `${origin}/api/storage/drivers/${driverId}/callback` and
the driver id in the path is what the callback route dispatches on. That is why a second
feature would seem to need a second registered URI.

It does not, because the state is already HMAC signed with the settings encryption key and
already carries the user id for exactly this reason: the callback arrives with no session
and nothing unsigned on it can be trusted. The target of the connection travels the same
way.

**The state payload becomes `{ userId, purpose, issuedAt }`.** The signer and verifier stay
exactly where they are, in `storage.models.ts`, one flat file, because there must be exactly
one HMAC implementation of this in the codebase and that file already is it. `purpose` is
`storage:googleDrive` for a Drive connection and `email:gmail` for a mailbox.
`storage.models.ts` keeps `signOAuthState` and `verifyOAuthState` as thin wrappers around the
new purpose-carrying functions: they map a driver id to `storage:<driverId>` and reject any
purpose that is not a storage one, so every existing storage caller and test is unchanged.

**The callback route stays where it is**, at
`/api/storage/drivers/googleDrive/callback`, because that is the address the user already
registered and never has to touch again. What changes is what it does:

1. Verify the state with the shared verifier. Signature and TTL first, before anything
   else is read. A bad state is rejected here as it is today.
2. Read `purpose` out of the verified payload and dispatch on it. Nothing else decides
   this. The `:id` path parameter is browser-supplied and unsigned, so for a foreign
   purpose it is ignored entirely.
3. A `storage:` purpose goes to `storageService.completeOAuthConnection` exactly as it does
   now, path parameter and all.
4. Any other purpose is looked up in an injected completer table keyed by purpose.
   `server.ts` wires `{ "email:gmail": emailService.completeGmailConnection }`. Storage
   imports nothing from email; it is handed a function, the same inversion that already
   hands it `countDocuments`.
5. A purpose that is not `storage:` and matches nothing in the completer table throws the
   same `storage.invalid_state` error a bad signature throws, before any completer is
   called. An unmatched purpose is exactly as untrustworthy as an unverified one: the route
   must never call a lookup result it has not confirmed exists.
6. The matched completer returns where to send the browser, so a Gmail connection lands on
   `/settings?tab=email&connected=gmail` and a Drive connection keeps landing on
   `/settings?tab=storage&connected=googleDrive`.

**Each completer verifies the state again, for itself.** The route's read is a routing hint
and nothing more. Storage's usecase keeps its own `verifyOAuthState` call and its own
driver id check, and email's does the same against `email:gmail`. Double verification is
cheap and pure, and it means nothing the route decides can weaken what a completer checks:
if the dispatch were ever wrong, an email callback sent to storage would be rejected by
storage's own verifier because the purpose is not a storage one. No existing storage test
changes.

**Email is handed the redirect URI, it does not build one.** `server.ts` wires email with
`buildRedirectUri: ({ origin }) => buildOAuthRedirectUri({ origin, driverId:
"googleDrive" })`. To email it is an opaque function producing the address to send Google
and to send back with the code exchange, which must be byte identical to the one used in
the authorize request. Email never names a storage route or a storage settings key, and the
fact that the two features share an address is one line of wiring, visible in one place.

**The connect route stays email's own**, at `GET /api/email/gmail/connect`. It requires a
session, since that is where the app learns who is connecting. The address Google returns
to is shared; the button the user presses is not.

### 3. The credentials are already there

The user's Drive connection is live: `storage.googleDrive.clientId`, `clientSecret`,
`refreshToken` and `accountEmail` all hold values. The design treats that as the normal
case and the empty case as the exception, in that order.

**Storage gains one method**, `readOAuthApp({ userId, driverId })`, returning the client id
and secret from that driver's own `oauth.keys`. `server.ts` wires email with
`getSharedGoogleApp: (userId) => storageService.readOAuthApp({ userId, driverId:
"googleDrive" })`, and that line of wiring carries a one line comment saying plainly that it
exists so other Google features can borrow the app registered for Drive, and that it is not
a storage concern, just where those values already live. Email's types declare an opaque
supplier of a client id and a secret. The secret is used in process only and never crosses
the API, as today. The existing `storage.googleDrive.*` setting keys are not renamed: the
user has a live connection stored under them and a rename risks a working connection for a
cosmetic win.

Email resolves its app credentials in this order:

1. `email.gmail.clientId` and `email.gmail.clientSecret` if set. The override is all or
   nothing: if one is set the other must be, and the connect route says so plainly rather
   than pairing one app's id with another app's secret, which fails at Google with an error
   nobody can read.
2. Otherwise the shared supplier, which is the Drive app.
3. Otherwise nothing, and the tab shows the first time path.

The Email tab reflects which one is in play, because a user who cannot see which
credentials are being used cannot debug anything. Normal case: "Using the Google app you
set up for Google Drive" above a single Connect Gmail button. Override: "Using the Google
app set on this page." Empty: the client id and secret fields, the redirect URI to
register, and a pointer to the Storage tab's guide, which is the one full walkthrough of
the console and stays the only copy of it.

### 4. The consent is its own, and so is the token

Drive's stored refresh token carries `drive.file` and nothing else. Mail access needs a
fresh consent carrying `https://mail.google.com/`, the restricted scope, because IMAP has
no read-only Google scope and the intake loop moves messages between folders anyway.

The consent asks for three scopes: `https://mail.google.com/`, `openid`, and
`https://www.googleapis.com/auth/userinfo.email`. The last two are there so the exchange
returns an id_token DocMind can read the address out of, and that address is what XOAUTH2
signs in as. Without them the user would have to type their own Gmail address into a field,
and removing fields is the point of this work. The id_token is verified with `verifyIdToken`
and its payload parsed with valibot before the address is used.

**Email holds its own refresh token**, in `email.gmail.refreshToken`, separate from
`storage.googleDrive.refreshToken`. Reasons, in order:

- Drive's token cannot grow a scope. A token's scopes are fixed at the grant that issued
  it, so mail access means a second exchange no matter what. Writing the result over
  Drive's key would silently replace a working Drive connection with a different one.
- Disconnect stays honest. Disconnecting Gmail must not stop file uploads, and
  disconnecting Drive must not stop mail. Two keys, two Disconnect buttons, no shared
  failure.
- One reconnect at a time. When a grant lapses, only the feature that lapsed asks for
  attention.

One honest limit: this separates DocMind's own buttons, not Google's. Google tracks
authorization per app and user, so removing DocMind under the Google account's third party
access page kills both tokens at once. The guide says so rather than implying otherwise.

### 5. Access tokens: one an hour, not one a minute

An access token lasts about an hour. The loop connects every 60 seconds. Minting a token
per cycle would be sixty pointless round trips an hour, each one a chance to fail.

The provider knowledge lives in one small new file, `apps/server/src/shared/google-oauth.ts`,
not a directory: how to build an authorize URL for a given set of scopes, how to exchange a
code, and how to mint an access token from a refresh token with a short cache. It knows
nothing about settings keys, drivers or mailboxes, and turns a failed exchange or refresh
into one of two neutral codes, `google.reauth_required` and `google.auth_failed`, never
logging or returning the token or secret involved. It is a plain file so a second Google
feature such as Calendar can import it later without moving anything.

**The Google Drive driver is left alone.** `google-drive.driver.ts` and
`google-drive.client.ts` keep their own sanitizing logic exactly as it is today, unrefactored
and untouched: the client keys its reconnect banner off the literal strings
`storage.reauth_required` and `storage.google_drive_error`
(`apps/client/src/lib/storage-reauth.ts`, `DocumentDetailPage.tsx`), and moving working,
shipped code so a new feature can share it is not a trade this change makes. Email's own
sanitizer duplicates the handful of lines that turn an `invalid_grant` into a reauth signal;
the duplication is small and the risk of touching Drive's error handling is not worth
avoiding it.

The token provider holds `{ token, expiresAt }` and calls Google only when the cached token
is inside five minutes of expiry. The email service memoizes one provider per client id
plus refresh token identity, compared in memory and never logged, and drops it when either
changes, so clearing or replacing a connection takes effect on the next cycle without a
restart. Steady state is one token fetch per hour.

The token is fetched at the start of a cycle, before the IMAP connection is opened, so a
dead grant fails before any mailbox work begins. The Test button takes the same path, which
is what makes it useful for this failure.

**When the refresh token is revoked or expires**, the provider throws
`google.reauth_required`. That must be visible, not merely true. Today
`email.imap.lastError` is written on every failed cycle and nothing reads it: the settings
list filters internal keys out and the Email tab never asks for it. A connection that can
expire on Google's schedule makes that gap unacceptable, so this work closes it.

### 6. Failures the user can see

A new read-only route, `GET /api/email/status`, is the email module's summary of its own
state:

    { mode, connectedAs?, credentials, redirectUri, needsReconnect, lastError? }

- `mode` is `gmail`, `password` or `unconfigured`.
- `connectedAs` is the connected Google address, or the IMAP user in password mode.
- `credentials` is `drive`, `override` or `none`, which is what section 3's line above the
  button is rendered from.
- `redirectUri` is the shared one, built from the request origin. In the normal case the
  tab does not ask anyone to register it, it only shows it under "already registered for
  Google Drive" so a mismatch can be spotted. In the `none` case it is the value to
  register.
- `needsReconnect` is true when the last failure was a reauth failure.

Nothing secret appears in it: no token, no password, not even a masked one.

**One function classifies every failure, for both modes.** `runOnce`'s single catch block
today only recognizes `email.imap_error`; a dead Google grant throws a different code family
(`google.reauth_required` or `google.auth_failed`) and would fall through to the generic "the
mailbox could not be checked" reason, which never sets `needsReconnect` even though the
grant genuinely needs reconnecting. One function, given an error, reads both families and
returns one of the fixed codes (`reauth_required`, `auth_failed`, `folder_missing`,
`network`, `unknown`) plus the short curated message that goes with it. It is called from
that one catch block and nowhere else builds this mapping a second way.

Two internal settings back it. `email.imap.lastError` keeps its current meaning, the short
curated reason, and a new `email.imap.lastErrorCode` holds the fixed code the classifier
returned. `email.imap.lastErrorAt` does not exist: nothing reads a last-failure timestamp,
so it is not a setting. `needsReconnect` derives from `lastErrorCode`, because deriving a
decision by string-matching curated prose is how curated prose becomes load-bearing and
unchangeable.

**Test and the banner must never disagree.** Today `testConnection` computes a result and
writes nothing to settings, so a successful Test would leave a stale `needsReconnect` from
an earlier failed cycle showing for up to a whole poll interval, and a failed Test would
leave a clean state that has not actually recovered. `testConnection` runs its attempt, then
writes `lastError` and `lastErrorCode` through the same classifying function `runOnce` uses,
clearing both on success, in both Gmail and password mode. The banner reflects whatever the
user just saw the Test button say, immediately, not on the loop's own schedule.

The Email tab shows a red banner when `needsReconnect` is true: "Gmail access has expired or
been revoked. Mail is not being collected." with a Reconnect button that walks the same
consent again. Any other `lastError` shows as a plain line.

### 7. Settings

Five new keys, all in the email module's own namespace:

| Key | Secret | Purpose |
|-----|--------|---------|
| `email.gmail.refreshToken` | yes | Written by the connect flow, never typed in. |
| `email.gmail.accountEmail` | no | The connected address, written by the connect flow. Also the XOAUTH2 user. |
| `email.gmail.clientId` | no | Optional override. Blank means use the app saved for Google Drive. |
| `email.gmail.clientSecret` | yes | Optional override, required if the id above is set. |
| `email.imap.lastErrorCode` | internal | Fixed code for the last failure, drives the reconnect banner. |

The refresh token and account email mirror storage exactly: secret where it matters, not
internal, so Disconnect is an ordinary settings write of two nulls through the existing API
and needs no new route. The Email tab filters both out of the generic field list, the way
`StorageTab` already does for a driver with an oauth hook.

Unchanged: `email.imap.host`, `port`, `user`, `password`, `folder`, `doneFolder`,
`failedFolder`, `pollSeconds`, `maxMessageSizeMb`, `lastError`.

**No database change.** Settings are rows in a key and value table, so new keys are registry
entries and nothing more. No table, no column, no migration. This is stated explicitly
because a database change would need the user's approval first, and this work does not have
one and does not need one.

**No new dependency.** `imapflow@2.0.5` already accepts `accessToken`, and
`google-auth-library@^11.1.0` is already a dependency of the server for Drive.

### 8. What Test does in each mode

The button stays where it is and its behavior follows the resolved mode.

- **Gmail:** mint an access token, connect, open the watched folder, report. "Connected to
  Gmail as you@gmail.com. 4 messages waiting." A revoked grant answers "Gmail access has
  expired or been revoked. Press Reconnect." A sign-in Google allowed but Gmail refused
  answers "Google accepted the account but Gmail refused the connection. If this is a
  Workspace account, check that your administrator allows IMAP." That last one matters:
  today's authentication-failed message tells the user to go and make an app password,
  which is exactly the wrong advice in this mode.
- **Password:** unchanged, including the existing app password wording.
- **Unconfigured:** "Connect Gmail, or fill in a host, mailbox address and app password,
  before testing."

### 9. The setup guide

The guide is client copy in `EmailTab.tsx`, as it is today, and becomes two: the Gmail one
shown by default, and the app password one behind the "Use a different mailbox provider"
disclosure, unchanged from today. The Gmail one is written for the case where the Google app
already exists, because it does.

**Connect Gmail**

Intro: "You already registered a Google app for Google Drive, and DocMind uses the same one
for mail: the same client, the same secret, the same redirect address. There is one field to
add on Google's side, then one button here."

1. Turn on the Gmail API for the same project. One button. The mail permission does not
   appear in the next step's list until this is on.
   (links to https://console.cloud.google.com/apis/library/gmail.googleapis.com)
2. Open Data access, press Add or remove scopes, paste `https://mail.google.com/` into the
   filter, tick it, then Update and Save. That is the only field. Do not touch the Clients
   page: your redirect address already covers this.
   (links to https://console.cloud.google.com/auth/data-access, carries a Copy button for
   the scope)
3. Come back here and press Connect Gmail. Google asks which account, then shows what
   DocMind is asking for.
4. The consent screen says DocMind wants to "Read, compose, send and permanently delete all
   your email from Gmail". That wording is Google's and it is the only wording available:
   IMAP has no smaller permission, so every IMAP app asks for exactly this one. What DocMind
   does with it is in the notes below. Press Continue.
5. You land back here and it says Connected as your address. Create the folder DocMind
   should watch in Gmail if it does not exist yet, then press Test.

Notes:

- DocMind reads one folder, moves a handled message to Done and a stubborn one to Failed. It
  never deletes a message, never sends one, and never opens your inbox.
- No new client, no new redirect address, no new consent screen to set up. The only thing
  you add in Google Cloud is the one permission in step 2.
- "Google hasn't verified this app" is expected. Press Advanced, then Go to DocMind. That
  warning exists for apps asking strangers for access. You are the developer and the only
  user.
- If Google refuses outright with access_denied on the mail permission, your app is
  published to Production, where Google gates this permission behind a paid security
  review. Set Audience back to Testing and add your own address under Test users, then read
  the next note. (links to https://console.cloud.google.com/auth/audience)
- In Testing mode Google expires the connection about every seven days. DocMind shows a
  Reconnect banner on this page when that happens and reconnecting is one press. Moving
  Audience back to Testing does the same to your Google Drive connection.
- Press Connect from the same address you used when you connected Google Drive, since that
  is the redirect address registered with Google. If that was http://localhost:5173, use
  localhost here too.
- Workspace accounts: if your administrator has turned IMAP off for the domain, sign-in
  fails even with a perfectly good connection. That one is not fixable from here.

**If there is no Google app yet** the tab shows a short second intro instead: "DocMind has no
Google app to reuse. Follow the Google Drive setup on the Storage tab, which walks through
the console once, then come back. If you would rather keep mail on its own app, paste a
client id and secret below and register the address shown." The console walkthrough exists
in one place and stays there.

**What the guide no longer asks for.** No IMAP host. No port. No mailbox address. No app
password, and so no trip to the app passwords page, no two-step verification detour, and no
explaining what an app password is. No second OAuth client and no second redirect URI. Four
fields and an external errand become one button, with one field left in Google Cloud that
only exists because the app is the user's own.

### 10. The tunnel

The redirect URI is built from the request origin. Through the Cloudflare quick tunnel that
origin is `https://<random>.trycloudflare.com`, and the random part changes every time the
tunnel restarts. Google requires the exact redirect URI to be registered before consent.

Reusing Drive's address changes this from a new problem into an old one with a known answer:
whatever address the user registered when they connected Drive is the address they must be
on when they press Connect Gmail. In practice that is localhost, since the Drive guide
already pushes people to connect from the machine running DocMind.

- From the machine running DocMind, `http://localhost:5173/api/storage/drivers/googleDrive/callback`
  is registered once and never changes. Google allows plain http for localhost. Vite proxies
  the callback to the server on 4000, so 5173 is the correct port here as it is everywhere
  else in this project.
- Through the tunnel it works too, but only if the current tunnel URL is the one registered,
  and it has to be re-registered after a tunnel restart if a reconnect is needed then.
- Once connected, none of this matters. The refresh token is not tied to the address it was
  obtained through. Only a fresh consent needs the redirect URI to match.

This is the same conclusion the storage driver spec review reached. It is repeated here
rather than cross-referenced because the person reading the Email tab is not reading the
Storage tab.

### 11. Testing

No test talks to Google, and no test opens a socket. The seam is the one
`email.client.test.ts` already established: the thing that would do IO is injected.

- **Pure, unit.** Mode resolution across every settings combination. Credential resolution
  across override, shared and empty, including the all-or-nothing override rule. The mapping
  from an error code to a curated reason and to `needsReconnect`.
- **Shared state unit, added to `storage.models.test.ts`.** A purpose round trips. A
  tampered payload, a wrong secret and an expired state are rejected, exactly as the
  existing driver-id tests already assert for their own shape. A state signed `email:gmail`
  is rejected by storage's wrapper verifier, and a state signed `storage:googleDrive` is
  rejected by email's completer. Every existing storage test in that file runs unedited.
- **Callback dispatch.** A Gmail state arriving at the storage callback path reaches the
  injected email completer and redirects to the email tab. A Drive state reaches storage's
  own completion, unchanged. A Gmail state with a `:id` path parameter naming some other
  driver still reaches the email completer, which is the assertion that the unsigned path
  parameter decides nothing. An unsigned or expired state reaches no completer at all. A
  state whose purpose is neither `storage:` nor in the completer table gets the same
  `storage.invalid_state` error a bad signature gets, not a 500.
- **Shared Google unit,** against an injected token endpoint function. A first call fetches
  and a second within the window does not, asserted on the call count. A call after expiry
  fetches again. An `invalid_grant` becomes `google.reauth_required` carrying no property of
  the underlying error. A generic failure becomes `google.auth_failed`. Neither the refresh
  token nor the access token appears in a message or a stack, mirroring the password
  assertions already in `email.client.test.ts`.
- **XOAUTH2 path,** against the existing fake connection factory. The factory receives
  `auth: { user, accessToken }` with no `pass`, and an authentication failure carrying the
  token in its own text produces an error containing no part of it. Passing both a password
  and a token, or neither, throws.
- **The loop,** against a fake token provider and the existing fake IMAP client. A Gmail
  cycle asks for a token once and connects with it. Many cycles inside one token lifetime
  ask for a token once between them, which is the cache assertion. A revoked token writes
  `lastErrorCode: reauth_required` and the status route reports `needsReconnect`. Gmail
  takes precedence over a configured app password. A password-mode cycle behaves exactly as
  its existing tests say, unchanged. A successful Test after a failed cycle clears
  `needsReconnect` immediately, and a failed Test sets it immediately, in both modes: the
  test asserting this calls `testConnection` directly and reads the settings it wrote,
  never waiting on the loop's own interval.
- **Routes.** Connect redirects to a Google URL carrying the three scopes,
  `access_type=offline`, `prompt=consent`, the shared redirect URI and a state. Connect with
  no credentials anywhere returns a clear 400, and so does a half-set override. The
  completer stores the refresh token and address through an injected exchange, responds with
  a redirect, and puts no token in a body or a header. The status route never returns a
  secret, asserted on the whole serialized body.
- **Client.** The tab renders the Gmail guide and a single Connect button with the "using the
  Google app you set up for Google Drive" line when credentials are found, the first time
  fields when they are not, the connected state with the IMAP fields collapsed once
  connected, the banner when `needsReconnect`, and the app password fields when the
  disclosure is open.

## Out of scope

- **Any other provider's OAuth.** Outlook and Microsoft 365 have their own app registration
  and their own consent model. The shared unit is a Google unit, deliberately named as one,
  and generalizing it before a second provider exists would be inventing requirements.
- **Gmail API instead of IMAP.** A Gmail-specific API client would avoid the restricted
  scope question for reads, but it would fork the intake pipeline in two: two ways to list,
  fetch and move, two sets of failure modes, two sets of tests. IMAP with XOAUTH2 keeps one
  pipeline, which is worth more than a friendlier consent screen.
- **Google's own verification.** A restricted scope in Production needs a third party
  security assessment. For a single user app that is not a trade anyone would make, and
  Testing mode plus a visible Reconnect banner is the answer instead.
- **Hiding the Google Cloud step entirely.** It cannot be hidden for a self-hosted app, for
  the reason in the Why. Reducing it to one field is the whole available win.
- **Watching Gmail labels rather than a folder.** IMAP presents labels as folders already,
  which is enough.
- **Push notification on new mail.** Unchanged from the intake spec: a minute of latency on
  an email is nothing.

## Risks

- **Seven day expiry in Testing mode.** This is the one that will actually bite. The user
  reconnects roughly weekly, and if the banner is missed, mail silently stops arriving. The
  status route and the banner exist for this reason and are not optional parts of the work.
  If weekly proves too annoying, the next lever is a notice in the app shell, or a Telegram
  message from the assistant when the intake loop has been failing for a day, not a change
  to the Google setup.
- **Moving Audience back to Testing affects Drive too.** A user who published their app for
  Drive and then has to unpublish it for mail gets a weekly reconnect on both. The guide
  says so where the instruction is given, rather than letting it be discovered.
- **The consent screen wording will alarm the user.** "Read, compose, send and permanently
  delete all your email" is Google's text for the only scope IMAP can use. The guide says
  plainly that it is the only option and what DocMind actually does. Nothing in the product
  can soften it and pretending otherwise would be worse.
- **The callback route now serves two features.** A change to it can break Drive, which is
  the storage everything else depends on. Mitigated by the completer keeping its own state
  verification, by storage's existing tests being untouched, and by the dispatch tests
  above. Worth naming because the blast radius of that one file just grew.
- **The state payload changes shape.** A consent started before this ships and completed
  after it fails with "Invalid oauth state". The window is the ten minute state TTL and the
  fix is pressing Connect again, so this is a note in the commit rather than a migration,
  but it is worth knowing before it is reported as a bug.
- **Two refresh tokens for one Google app.** Google issues a new refresh token on each
  consent with `prompt=consent` and keeps older ones valid up to a per app and user limit.
  Two is nowhere near it. Recorded so a future third Google feature does not quietly assume
  tokens are free.
- **Adding a scope to a shared app widens what one stolen client secret could ask for.** The
  secret is encrypted at rest and never leaves the server, and the mail scope is only ever
  granted by the user pressing Connect and approving. Noted rather than mitigated, because
  the alternative is the second app the user explicitly did not want.
