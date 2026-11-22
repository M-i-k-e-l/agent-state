# Push to your phone

With **📱** on in the Sessions pane, each session of the desktop app sends a push to your phone when it stops working
and waits: 🔐 permission, ❓ input, 🙋 needs you or 💤 idle. It is free and needs no account. The pushes go through
[ntfy.sh](https://ntfy.sh), a public service, and your phone gets them in its browser or in the ntfy app.

- [Not private](#not-private)
- [The topic](#the-topic)
- [Set up on Android](#set-up-on-android)
- [Set up on iPhone](#set-up-on-iphone)
- [Push on idle](#push-on-idle)
- [Keep missed pushes](#keep-missed-pushes)
- [Only when I'm away](#only-when-im-away)
- [Priority](#priority)
- [What a tap opens](#what-a-tap-opens)
- [When no push arrives](#when-no-push-arrives)
- [When a tap doesn't open the session](#when-a-tap-doesnt-open-the-session)

## Not private

- Anyone who knows your topic can read your pushes, and ntfy.sh can too.
- A push holds the state's icon, the session's name and, for a session with Remote Control, its link.
- The link opens only for someone signed in to your Claude account.
- The mod asks ntfy.sh not to keep the push, unless you turn on [Keep missed pushes](#keep-missed-pushes).
- Pushes go to ntfy.sh only. A server of your own isn't supported yet.

## The topic

The topic is the name your pushes go to. Whoever subscribes to it gets them, so treat it as a password.

- The first time you open the **▼** menu next to **📱**, the mod makes a topic at random on your Mac: 36 characters,
  such as `3f0c9a52-7d1e-4b8a-9c66-0e2d5a71b3f4`. It is not made from anything of Claude's or yours.
- **🎲 New topic** makes another. You can also type your own: 16 to 64 letters, digits, `-` or `_`.
- **Save** keeps it in the mod's own store on your Mac, for every session, and turns **📱** on the first time.
  **Cancel** puts the saved topic back in the field. Neither closes the menu: **▲** does.
  Until you save, pushes go to the topic saved before, or nowhere.
- **⧉**, after the link, copies `https://ntfy.sh/<topic>`, the link to open on your phone. Send it to your phone in a
  way you trust, as it holds the topic.
- After you change the topic, the phone has to subscribe to the new one.

## Set up on Android

In Chrome:

1. Open the topic link.
2. In the page, open ntfy's **Settings**.
3. Allow notifications for the browser if it asks.
4. Turn on **Background notifications**. Without it, pushes come only while the page is open.
5. On your Mac, press **Send test push** in the menu.

With background notifications on, the ntfy tab can be closed and Chrome need not be running.

Chrome's pushes are unreliable while the phone is idle: one can come late. The ntfy app is the more reliable way.

The other way is the ntfy app, from Google Play or F-Droid: install it and subscribe to the topic there. A tap on its
push opens the session in the Claude app directly.

## Set up on iPhone

Needs iOS 16.4 or later. In Safari:

1. Open the topic link.
2. Tap **Share**, then **Add to Home Screen**. The icon is named **ntfy**.
3. Open **ntfy** from the Home Screen. Pushes work only from there, not from a Safari tab.
4. Subscribe to your topic there: tap **Subscribe to topic** and enter the topic, the part of the link after
   `ntfy.sh/`.
5. Allow notifications when it asks.
6. On your Mac, press **Send test push** in the menu.

The other way is the ntfy app, from the App Store: install it and subscribe to the topic there.

## Push on idle

**Push on idle**, in the menu, says whether a session that just finishes and goes 💤 idle sends a push. It is on until
you turn it off, and it is for every session.

- **On:** every stop sends a push: 🔐 permission, ❓ input, 🙋 needs you and 💤 idle.
- **Off:** only 🔐, ❓ and 🙋 send one, the stops that need you.

ntfy.sh takes 250 pushes a day from one network address, and at most 60 in a burst, which refills by one every 5
seconds. Everything on your network that sends to ntfy.sh shares that count. With many sessions, plain 💤 pushes are
most of the day's count, so turning **Push on idle** off is the way to stay under it. Past the limit ntfy.sh refuses
the push: the session's row shows **🔕**, and a toast says "ntfy.sh answered 429".

## Keep missed pushes

**Keep missed pushes**, in the menu, is off until you turn it on, and is for every session.

- **Off:** the mod asks ntfy.sh not to keep the push. A phone that is offline or not subscribed at that moment never
  gets it.
- **On:** ntfy.sh keeps each push for 12 hours, as it does by default. A phone that connects later gets what it missed,
  and anyone who opens the topic in that time can read those pushes.

Either way, a push the phone did get stays in ntfy on the phone until ntfy deletes it there: its **Settings**,
**Delete notifications**. That setting is the phone's own and changes nothing on ntfy.sh.

## Only when I'm away

**Only when I'm away**, in the menu, holds a push back while you are at the Mac. It is off until you turn it on, and
it is for every session.

- At the Mac means the keyboard or the mouse was used in the last 2 minutes. **Away after**, under the toggles, sets
  another time in seconds: a whole number, 10 to 3600, kept as you type it. The mod asks macOS for the time since
  the last key or pointer move, and reads nothing else.
- It is checked once, as the push is about to go. A push held back is not sent later.
- Watching something without touching the Mac for that long counts as away.
- Typing in the session from your phone doesn't count as being at the Mac.
- **Send test push** is always sent.

## Priority

**Priority**, in the menu, is ntfy's own priority for every push, the test push too: 1 (min) to 5 (max). It is 3,
ntfy's default, until you pick another, and it is for every session.

- **In the ntfy app** it sets how loud the push is. ntfy's docs say: 4 and 5 vibrate longer and pop up, 3 is a normal
  sound and vibration, and 1 and 2 make no sound.
- **In the ntfy app on Android, from Google Play**, ntfy.sh marks a push urgent for the phone only at 4 or 5. An
  urgent push is the one a locked, idle phone should show at once, so 4 is the one to try when pushes come late.
- **In Chrome, or ntfy on an iPhone's Home Screen**, it changes nothing about when a push comes: ntfy.sh marks those
  urgent whatever the priority.

The two points about "urgent" were read in ntfy's server code, not measured on a phone.

## What a tap opens

A push links to its session only when the session has Remote Control on. The link opens the Claude app, so the phone
needs the Claude app, signed in to the same account.

- **Android, ntfy app:** tap the push, and the session opens in the Claude app.
- **Android, Chrome:** tap the push. Chrome opens and shows **Continue**. Tap it, and the session opens in the Claude
  app.
- **iPhone:** tap the push. ntfy opens. Tap **Open link** on the push there, and the session opens in the Claude app.

A push that comes from a web page can't do it in one tap: a phone doesn't let a web page's notification open another
app directly. The ntfy app on iPhone was not tested.

## When no push arrives

On your Mac:

- **📱** reads **On**? It turns on only once a topic is saved.
- The menu says **Not saved yet**? Press **Save**: pushes go to the saved topic only.
- Press **Send test push**. The toast says whether ntfy.sh took it. If it did, the Mac's side works.
- A **🔕** on a session's row means its last push failed. Press it to see why.
- A toast that says "ntfy.sh answered 429" means too many pushes: ntfy.sh takes 250 a day from one network address,
  and short bursts of 60.
- **Only when I'm away** is on, and you used the Mac in the last 2 minutes, or in the time set in **Away after**? The
  push was held back.
- A push is sent only by a session of the desktop app, and only as it stops working. A session that ends sends none,
  and neither does a session another session started.
- A session that finishes with a command or a subagent still running in the background (💤 with ⏳, or 🧵) sends no
  💤 push. It does send 🙋 when its turn ended asking you something.
- After updating the mod, restart the app.

On your phone:

- It is subscribed to the same topic the menu shows? After **🎲 New topic** it is a different one.
- Notifications are allowed for Chrome (Android) or for ntfy (iPhone) in the phone's settings, and no Focus or Do Not
  Disturb mode hides them.
- **Android:** with Chrome, a push can come late while the phone is idle. The ntfy app is more reliable.
- **Android:** **Background notifications** is on in ntfy's Settings. Chrome wasn't force-stopped, and the phone's
  battery saver doesn't restrict it. Clearing Chrome's data for ntfy.sh removes the subscription.
- **iPhone:** ntfy was added to the Home Screen and the topic was subscribed inside it, not in a Safari tab.
- ntfy pauses background notifications for a phone that hasn't opened it in a while, and warns before it does. Open
  ntfy again to resume.

## When a tap doesn't open the session

- The session has no Remote Control: its push has no link. Turn Remote Control on for the session.
- The Claude app isn't on the phone: the link has nothing to open.
- The Claude app shows an error: it is signed in to another account than the session's.
- **Android:** Chrome opened and nothing else happened: tap **Continue** on its page.
- **iPhone:** ntfy opened and nothing else happened: tap **Open link** on the push.
