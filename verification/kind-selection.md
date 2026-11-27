# Kind selection record (2026-11-27 UTC)

1. Initial design picked kind 7107 (not in the official NIP kind list at nostr-protocol/nips README).
2. Local browser E2E showed kind 7107 events already exist on relays: nostr.mom had 9 events
   from "satminer" (content JSON `{"result":"win",...}`, tags d/p/t/alt/client) — another app uses 7107 with `p` tags.
   Our receive filter would have rejected them (content must be exactly "Yo!" and valid sig), but sharing a kind is poor design.
   The only other 7107 events seen were the 1 test Yo from our own E2E run (throwaway key).
3. Scanned candidates on nos.lol, nostr.mom, yabu.me, relay.primal.net, nostr.wine, relay.snort.social, offchain.pub
   (`scripts/kind-scan-candidates.mjs`, limit 500 per relay):
   `{"1600":0,"1601":0,"1602":1,"4040":308,"4041":100,"5050":1202,"6060":0,"7070":241,"7071":0,"7117":0,"8086":0,"8087":0,"9690":0,"9691":0}`
4. Chose **kind 7117**: regular range (1000–9999, stored by relays), not in NIP list, 0 events seen.
   Residual risk: absence on 7 relays at one point in time does not guarantee no one else uses it.
