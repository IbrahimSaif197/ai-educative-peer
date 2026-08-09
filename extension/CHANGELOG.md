# Changelog

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
