# YouTube Transcript Copy

Chrome extension that copies the transcript of the current YouTube video to the clipboard in one click.

## Features

- **One click** — press the extension icon on a video page and the transcript is in your clipboard
- **Keyboard shortcut** — `Alt+Shift+T`
- **Readable output** — plain text split into paragraphs, no timestamps
- **Works with auto-generated captions** as well as manually added ones
- **Minimal permissions** — runs only on the tab you click it on, no background access to pages

## Installation

1. Clone/download this repo
2. Open `chrome://extensions/`
3. Enable **Developer mode** (toggle in top right)
4. Click **Load unpacked**
5. Select the `ts-extract` folder

## Usage

Open a YouTube video and click the extension icon (or press `Alt+Shift+T`).

| Result | Meaning |
|--------|---------|
| Green toast, **✓** badge | Transcript copied, the toast shows its length |
| Red toast, **✗** badge | No transcript — the toast says why (e.g. the video has no captions) |
| **✗** badge only | The current tab is not a YouTube page |

The shortcut can be changed at `chrome://extensions/shortcuts`.

## How It Works

The extension opens YouTube's own transcript panel, reads the text from it and closes the panel again, so the panel flashes on screen for a couple of seconds. Fetching the caption track directly is tried first, but YouTube currently answers such requests with an empty body.

Reading the panel depends on YouTube's page markup. If the extension stops finding transcripts after a YouTube redesign, the selectors in `background/service-worker.js` (`fromPanel`) are the place to fix.
