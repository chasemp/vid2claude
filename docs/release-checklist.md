# Release checklist

Everything here is a command, except the last section, which needs hardware.

```sh
npm run typecheck
npm test                 # bundle structure, timestamp monotonicity, frame cap, ZIP round trip
npm run build
npm run check-pwa        # offline second load, share-target endpoint, under a project subpath
npm run fixtures && npm run spikes   # the assumption checks, against real modules in a real browser
npm run validate-bundle -- fixtures/spike-bundle.zip
```

What each of the plan's per-release checks maps to:

| Check | Where it runs |
| --- | --- |
| Bundle structure validator | `scripts/validate-bundle.ts`, and `tests/bundle.test.ts` on every run |
| Transcript timestamp monotonicity | `tests/segments.test.ts`, and the validator on a real bundle |
| Frame count cap | `tests/align.test.ts` |
| Offline second run | `npm run check-pwa` |
| Memory ceiling | spike A3 reports peak JS heap; see the caveat in [spikes.md](spikes.md) |

## On a phone, before saying a release is good

The automated checks all run on a desktop browser, and the app's whole point is
phones. Against a real 90 second recording, on at least one iPhone and one
Android phone:

1. Bundle is produced in under 60 s and under 15 MB (Phase 1 acceptance).
2. Spot-check three transcript timestamps against the audio; each within 0.5 s.
3. Second run makes no network requests (airplane mode is the honest test).
4. Portrait recordings appear upright in `frames/`.
5. Android: sharing from the gallery starts processing with no picker.
6. Fill in the row you just proved in the device matrix in
   [spikes.md](spikes.md).
