# Configuration

The environment variables ResearchTool reads when it starts.

[Back to the README](../README.md)

## Environment variables

| Variable | Default | What |
| --- | --- | --- |
| `PORT` | 4790 | port (the server only listens on 127.0.0.1) |
| `RT_WORKSPACE` | `./workspace` | data folder |
| `RT_BURST_MS` | 300000 | autosaves within this time are merged into one history version |
| `RT_OVERLEAF_GIT_BASE` | `https://git.overleaf.com` | Git server used for Overleaf sync (tests) |
| `RT_OVERLEAF_NET_TIMEOUT_MS`, `RT_OVERLEAF_CLONE_TIMEOUT_MS` | 45000, 180000 | network timeouts of git |
| `RT_CATEGORIZE_TIMEOUT_MS`, `RT_REGROUP_TIMEOUT_MS`, `RT_REGROUP_CHUNK`, `RT_BRIEF_BATCH` | see `lib/categorize.js` | limits of the grouping calls; papers per brief call (6) |
| `RT_BACKUP_FIRST_MS` | 90000 | delay before the first automatic backup check after the start |
| `RT_VOICE_DIR` | a folder of your user account (see [Read aloud](guide.md#read-aloud-and-dictation)) | the downloaded voice is kept in a folder `researchtool-voice` inside the folder named here |
| `RT_VOICE_MIRROR` | unset | an `http://127.0.0.1:...` address that has the voice's files under their names (for trying the download without the internet; the checksums are checked all the same) |
| `RT_NO_UPDATE` | unset | `1` switches the app's own updates off completely - no check, no download, whatever Preferences says (it can only switch them off) |
| `RT_UPDATE_FIRST_MS` | 75000 | delay before the first automatic update check after the start (only with "Keep ResearchTool up to date automatically" ticked) |

Set them before `node server.js`; [Quick start](install.md#quick-start) shows how on macOS, Linux and Windows.
