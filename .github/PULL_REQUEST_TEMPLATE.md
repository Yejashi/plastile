## What this changes

<!-- The behaviour change and why. Link the issue if there is one. -->

## How it was tested

<!-- Say which layers ran and on which KWin version. Results from one layer do not stand in for another. -->

- [ ] `npm run check` (type check, unit and replay tests, bundle)
- [ ] Nested KWin scenarios: <!-- which ones, which KWin version -->
- [ ] Physical session: <!-- what you checked by hand, or "not run" -->
- [ ] `python3 tools/check_docs.py` (if docs changed)

## Checklist

- [ ] Follows the rules in [CONTRIBUTING.md](https://github.com/Yejashi/plastile/blob/main/CONTRIBUTING.md#rules-every-change-follows) (single geometry writer, no timers on the command path, teardown for everything owned)
- [ ] User docs and [CHANGELOG.md](https://github.com/Yejashi/plastile/blob/main/CHANGELOG.md) updated if behaviour, defaults or shortcuts changed
- [ ] No private data (window titles, home paths, raw physical logs) committed
