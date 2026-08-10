# Changelog

## 1.4.0

- EduPeer answers you now. Tell it the right answer and it says so, explains
  why in a sentence, and moves you on, instead of asking the question you
  just answered. Every reply used to end with the same sentence, which is
  what made it feel like a loop; it closes on a question only when it is
  actually waiting on you.
- Working something out in the chat now counts as trying, so hints get
  deeper as you reason rather than only when you edit code. Saying "i dont
  know" still doesn't.
- The "explain it in your own words" prompt appears once per file instead of
  returning every time you change a line.
- Each function gets its own conversation — code that sits outside one shares
  the file's — and conversations no longer outlive the window. The chat you
  are reading and the hint level beside it finally describe the same thing.
- Enter sends your message; Shift+Enter starts a new line.
- "How sure are you?" is gone, and with it the calibration score on the
  progress dashboard.
- The "I fixed it" button is called "Quiz me", which is what it does.

## 1.3.1

- Fix hints that outlived the mistake they described. A practice file's
  `# bug:` note was being sent to the tutor along with the code, so the tutor
  answered from the note: fix the line and it would still be flagged, and
  still be asked about the mistake you had just corrected. The note is now
  stripped from what gets sent — the scan, the inline hint and the chat all
  read your code and nothing else. You still see the note in your file until
  it goes.
- This also unsticks the note itself. Removing it waits for the file to scan
  clean, which could never happen while the note was the thing keeping the
  file flagged.

## 1.3.0

- The tutor panel has been rebuilt. It has its own look now instead of
  borrowing the editor's, replies arrive in cards rather than as plain text,
  and your own messages sit in their own bubble.
- The hint depth meter moved out of the bottom of the panel and into the hint
  it describes, so you can see at a glance how deep any answer went.
- Your practice streak shows at the top, and the panel marks the moment a file
  stops being flagged.
- Everything moves now: replies rise into place, the depth dots fill as the
  tutor goes deeper, and the marker follows your cursor. If you have "reduce
  motion" turned on, the panel respects it.
- Note: this panel no longer follows your VS Code colour theme, including the
  high-contrast themes.

## 1.2.0

- Fix the bug in a practice file and the `# bug:` note describing it now
  disappears by itself, instead of sitting there pointing at code that is
  already correct. Only comments that start with `bug:` go, so your own notes
  and anything that just happens to mention a bug are left alone. This is the
  one time EduPeer edits your file: a single undo puts the comment back, and
  `edupeer.removeFixedBugComments` turns the whole thing off.

## 1.1.0

- The inline lens now shows its own state. Clicking it says "thinking"
  straight away, a failure says what went wrong and offers a retry or a
  sign-in link, and a line with nothing to flag says so. Previously every
  failure was silent.
- Lenses on definition lines (functions, classes and the like) read "Ask
  EduPeer" now, a plain offer. Only a line EduPeer actually flagged poses a
  question.
- Flags, hints and diagnostics are dropped the moment you edit the code they
  describe, and shift with the lines when you edit above them.
- The sidebar panel shows the function you're in, with its real editor line
  numbers, instead of the whole file (a "Whole file" toggle switches back
  when you want it). The hint ladder and the attempt gate are scoped to that
  block too, so editing an unrelated line no longer unlocks a deeper hint.
- New setting `edupeer.lensMode`: set it to "flagged" to only see lenses on
  lines EduPeer has actually flagged, instead of an offer on every function.
- Rebuilt the sign-in page: clearer error messages instead of raw Firebase
  codes, a show/hide toggle for your password, and it now scrolls properly
  at high display scaling or heavy browser zoom instead of trapping the Sign
  in button off-screen. Also fixed: a successful sign-in whose handoff back
  to VS Code failed used to say "Sign-in failed." It now shows the "You're
  in" card with a working "Send it again" button.
- When you're signed out, the chat sidebar now invites you to sign in
  instead of showing an empty panel. Ask a question anyway and the
  invitation gets out of the way for your answer, instead of stacking next
  to it.

## 1.0.1

- Fix sign-in failing with "Failed to fetch". The signed-in session is now
  handed back through VS Code's URI scheme instead of a POST to a local
  server, which browsers had started gating behind a permission prompt about
  accessing other apps on your device. Declining that prompt previously left
  sign-in broken with no way to recover.

## 1.0.0

First public release.

- Socratic chat sidebar with attempt-gated hint levels — asking again holds the
  level, editing the code advances it.
- Inline line-level nudges and automatic file scanning into the Problems panel.
- Trace, predict-the-output, explain-construct, explain-error and reflection
  quiz commands.
- Progress dashboard with concept mastery, confidence calibration and spaced
  review.
- Badges, streaks and learning goals, synced to a signed-in account.
- Offline fallback tutor for when the backend is unreachable.
- Python, JavaScript, TypeScript, Java, C, C++, C#, Go, Rust and SQL.
