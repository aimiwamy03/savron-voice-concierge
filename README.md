# Voice Concierge

An AI phone front desk for barbershops, built for SAVRON Barbershop & Lounge in Minneapolis. It answers in English and Spanish, takes booking requests, and hands off to a person.

**No shop facts live in this code.** A shop is one file, `shops/<id>.json`, that says where to look and how to read each page. Names, prices, barbers, hours, and policies are pulled from the live pages, and re-pulled at the start of a call once the last pull is 5 minutes old. If a page changes, the next caller gets the new answer.

## Run it

Needs Node 22 or newer and a [Deepgram](https://deepgram.com) key.

```bash
npm install
cp .env.example .env      # add DEEPGRAM_API_KEY
npm start                 # http://127.0.0.1:3000
```

Click **Start call** and talk. The page shows each source and when it was read, what the agent knows, tool calls, requests, and texts.

To see the live pull with no key:

```bash
npm run live              # what the agent knows right now
npm run live -- savron --prompt   # the exact prompt
```

## Where each fact comes from

| Source | What it gives |
|---|---|
| savronmn.com home | Name, address, email, rating, socials, walk-ins, service names and descriptions, membership |
| savronmn.com journal menu article | Prices, lengths, add-ons |
| savronmn.com/terms | Cancellation rule |
| ClassPass | Phone, full address with suite |
| Booksy (Krisbladez@Savron) | Kris's name, hours, own menu, prices, cancellation policy. Marks him as an outside calendar |
| North Loop article | The owner's name |

When sources disagree, the earlier one in the config wins and the page flags it. When a source is down, the rest still load and the page says which failed. When every source is down, the last good pull is used and marked stale.

Anything not found stays unknown, and the agent says the team will follow up. It does not guess. Those gaps today: whole shop hours, parking, the current wait, payment methods, late arrival rules, holidays, and the full barber roster.

Only parsed fields reach the agent, never raw page text, because a page can carry text written to steer an AI. SAVRON's own `llms.txt` does, so it isn't a source.

## Add another shop

1. Copy `shops/savron.json` to `shops/<new>.json`.
2. Change the URLs, timezone, and the rules that find facts on that shop's pages. Any barber on Booksy only needs `"type": "booksy"` and a URL.
3. Run `npm run live -- <new>` and fix rules until the output is right.
4. Start it with `SHOP=<new> npm start`.

## Booking is a request, for now

Neither calendar is connected, because that needs the owner's permission and access. So:

- `check_availability` never claims a time is open. It uses a barber's published hours when they exist.
- `book` sends a request to the shop. `request_approval` texts a Booksy barber, or the shop if there's no number for that barber.
- `reschedule` and `cancel` send a request to a person.
- The caller is told it's a request and gets a text.

To connect a calendar, add its read and write calls in `src/tools.js`, where the comment at the top marks the spot.

The server also won't save a number until the agent has read it back and the caller has answered, and won't move or cancel until the caller has answered.

## Texts and phone calls (optional)

Without Twilio settings, texts appear on the page and are not sent. With `TWILIO_*`, `SHOP_NOTIFY_PHONE`, and `BARBER_PHONES` set, they go out.

For real calls, set `PUBLIC_URL` to a tunnel or host that reaches this server, and point the Twilio number's voice webhook to `POST <PUBLIC_URL>/twilio/voice`. Webhooks are checked against Twilio's signature, and each stream needs a one-time token. Through a tunnel, only `/twilio/*` answers. The page and its data stay local.

## Tests

```bash
npm test                    # offline: parsing, merging, tools, full call against fake Deepgram and Twilio
npm run validate:settings   # live pull, checked against Deepgram's published schema
npm run test:calls          # the build sheet's 10 test calls against a real agent (uses Deepgram credit)
npm run test:calls -- 3,6   # just those calls
```

## Files

- `shops/` one config per shop
- `src/live/` fetching, page parsing, merging, and refresh
- `src/prompt.js` prompt and greeting, built from the snapshot on each call
- `src/tools.js` the agent's tools and the request ledger (in memory, cleared on restart)
- `src/session.js` bridge to Deepgram, read back and confirm gates, voice switching
- `src/sms.js`, `src/twilio.js` texts and phone calls
- `public/` the demo page
