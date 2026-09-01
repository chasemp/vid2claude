# repo-kit

Files that belong in the repository you are debugging, not in this project.

## `.claude/skills/repro-review/SKILL.md`

Teaches Claude Code how to read a reproduction bundle: README first, then the
transcript, then the frames in time order against `manifest.json`, and to write
down the steps, the failure and the first suspicious frame before touching code.

Install it with:

```sh
./repo-kit/install.sh /path/to/your/repo
```

Then commit it. A Claude Code cloud session starts from a fresh clone and loads
skills from the repository's `.claude/skills/`; a skill in your own
`~/.claude/skills/` is not visible there.

## Optional: cloud environment setup script

Only needed if you also commit raw `.mp4` files and want Claude to be able to
poke at them directly. In the environment dialog's setup script field:

```sh
apt update && apt install -y ffmpeg || true
```

Setup scripts run as root on Ubuntu 24.04 and `archive.ubuntu.com` is on the
default trusted network allowlist, so this works without widening network
access. `ffmpeg` is not pre-installed.

A bundle produced by vid2claude does not need this: it is already text and PNGs.
