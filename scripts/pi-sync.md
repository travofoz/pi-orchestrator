# pi-sync — Bootstrap a new device with lotek theme + settings

## For the LLM running this

1. Clone the repo
2. `cd pi-bake`
3. `./scripts/pi-sync.sh bootstrap`
4. `pi`

That's it. The script backs up any existing `~/.pi/agent/`, copies in the
committed settings/theme/packages, and runs `pi install` for each package.

## Files committed in repo

| File | What it is |
|------|-----------|
| `scripts/pi-bootstrap/settings.json` | Theme: lotek, provider: opencode, model: deepseek-v4-flash-free |
| `scripts/pi-bootstrap/themes/lotek.json` | hotPink + lime terminal theme |
| `scripts/pi-bootstrap/packages.txt` | 5 packages to install |

## Commands

```
./scripts/pi-sync.sh bootstrap     # install from repo (use this)
./scripts/pi-sync.sh export        # package current config to tarball
./scripts/pi-sync.sh import <path> # restore from tarball or directory
```

## Rollback

The script backs up to `~/.pi/agent.bak.<timestamp>`. Restore with:

```
rm -rf ~/.pi/agent && mv ~/.pi/agent.bak.* ~/.pi/agent
```
