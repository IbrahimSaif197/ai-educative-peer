# Changelog

## 1.7.0

### Smaller things

- **A clean scan celebrates again.** The streak moved to the footer in this
  same release and the little flourish that pops it when a file comes back
  clean did not move with it, so it was animating something that no longer
  existed. Nothing looked broken; there was simply nothing there.
- **Tab stays inside the preferences popover.** It used to walk out into the
  panel behind it, leaving you operating controls you could not see with the
  popover still open over them.
- **The trace grid reads properly aloud.** It now says how many steps and
  variables it has as you enter it, and each column header is tied to its
  column. Submitting hands focus to the marking, instead of dropping it and
  leaving you to hunt for the reply you just asked for.
- **Dragged wide, lines stop running the full width.** Past about 420px the
  text settles to a comfortable measure; the extra width goes to the language
  chip and the spelled-out ledger instead of to longer lines.
- **Three bits of decoration stopped being read aloud.** The Ask button
  announced itself as "Ask, return-arrow"; the progress link in the footer
  read out the chevron on the end of it. Those marks are still there to look
  at — they are just no longer part of what a screen reader says.
- **Two marks that show as empty boxes on some Linux setups** — the arrow on
  the composer strip and the chevron on the file row — are drawn properly now
  instead of relying on a font having them.
- **Dragged into the bottom dock, the panel goes two-column** — conversation
  on the left, everything else on the right — rather than stacking three
  horizontal bands into a strip too short for any of them.

### Your learning goal now actually does something

Setting a goal has always turned your sentence into concept tags — say "get
comfortable with recursion" and it works out that you mean `recursion` and
`base-case`. Those tags were then shown to you once and quietly ignored. Only
the sentence itself reached the tutor.

They now steer two things. The tutor is told which concepts you are working
towards in its own vocabulary, and leans towards those framings **when your
code genuinely touches them** — it will not answer a string-formatting
question with recursion because you asked it to care about recursion. And when
a spaced review comes due, concepts from your goal get the slots first.

What a goal still will not do is change *when* something comes back for
review. Things resurface 3–7 days after you struggled with them because that
is roughly when it helps; wanting it sooner would not make it work better.

### EduPeer no longer edits your code. At all.

There was one exception, and it is gone: a setting that tidied away `bug:`
marker comments from a block once it scanned clean. It existed for the bundled
demo files, which seed a comment naming each planted bug so you can see what
the exercise is — and nothing else has ever written one. On your own code it
could only be a risk of touching a file it had nothing to say about, so the
setting and the edit behind it are both removed. The preferences panel is one
row shorter.

What has not changed is the half that matters: those comments are still
stripped out of everything sent to the tutor. A tutor handed
`# bug: off-by-one, skips the first item` is not finding your bug, it is
reading the answer off the line above it.

### The panel, rebuilt

- **EduPeer follows your theme now.** Light, dark, and both high-contrast
  themes each get their own version of the panel — same layout, same colours
  where they still work, readable ones where they did not. If you use a light
  theme, the sidebar has been dark since 1.3.0 and no longer is.
- **The empty panel teaches you the rules before you need them.** It used to
  be one sentence floating in the middle of a lot of nothing. It now sits just
  above the box you type in, says what EduPeer will and will not do — you get
  a question back, not working code; four levels of depth; the fourth is a
  worked example — and offers three ways to start instead of a blank field.
- **Hint depth is a staircase.** Four dots became four bars that get taller,
  so how deep you are reads at a glance. The next one is outlined rather than
  filled, because it costs you something, and the fourth is drawn differently
  because it is a worked example rather than another question. When EduPeer
  refuses to go deeper it says so on that reply, and keeps saying it.
- **Every reply looks like what it is.** Asking, showing you something,
  telling you outright, and refusing are four different-looking cards now,
  instead of fifteen slightly different ones. The buttons under a reply sit
  inside it, attached to the thing they act on.
- **The file strip stopped repeating your editor.** Your code was on screen
  twice: once in your editor, once in a panel eight pixels away. The panel now
  shows one line — which file, which function, which lines — and keeps the
  copy behind a toggle. Opening a file when none is open is a button on that
  same line, rather than the words "no file open" in two places.
- **The box you type in tells you how it will read what you write.** When
  EduPeer has asked you to translate something, or predict an output, or label
  the steps, the box says so and the button changes to match — and there is
  always a way back to just asking a question. Escape works too. It was
  possible to be left in one of those modes without knowing it, and to have
  your next real question answered as if it were homework.
- **Your streak and badges moved to the bottom.** They were the first thing
  you saw, above a tutor that had not said anything yet, and the badges were
  folded away where you would never see them. They are a single line under the
  box now, always visible. The flame is gone; it says "streak".
- **Two kinds of problem, two kinds of banner.** "Can't reach the server" and
  "your sign-in is broken" are different things and now look different, and
  each has a button that does something about it. The sign-in one leaves a mark
  on your account picture that stays until it is actually fixed — dismissing
  the message never fixed anything.
- **The lightbulbs are gone from your editor's margin**, along with every other
  emoji there. A screen reader used to read them out; on some Linux setups they
  showed as empty boxes. Every one now starts with the word EduPeer and says
  what it is doing: asks, notes, is thinking, can't.
- **A big file no longer floods the margin.** "Show on every line" put a lens
  on all forty functions of a forty-function file. It shows the eight biggest
  now, with one entry at the top of the file that lets you pick any of the
  rest. If you had chosen "flagged", nothing changes.
- **Your progress page matches the panel.** Same colours, same typefaces, same
  depth scale, and it follows your theme too.
- Reduced motion means no movement, not no feedback. Three things used to
  simply vanish when it was on — the celebration when a file comes back clean,
  the sign that EduPeer is holding a hint back, and a banner arriving. Each now
  has something that stays still and can still be seen.

### The rest

- Your account and your settings now live behind one picture in the top-right
  corner. Everything that changes how the tutor behaves is in there — whether
  it marks up your editor, how long it waits before offering a hint, whether
  it offers on your functions or only on flagged lines — and changing
  one takes effect straight away. You no longer have to go looking in VS Code's
  settings for any of it.
- The ring around that picture is how deep you are into a hint. Four segments,
  one per level, filled up to where you are. It empties when you start fresh.
- **Reset is instant.** It used to sit there for as long as the server took —
  which, if the server had gone to sleep, could be the best part of a minute —
  with the old conversation still on screen and nothing to say it had heard
  you. It now clears the moment you press it. The "what you learned" note still
  comes from the server, so it arrives a second or two later, on its own.
- Reset also asks first, and stops listening while it runs. Pressing it twice
  used to send two of everything.
- Hints stop giving the game away. At level 2 the tutor would sometimes name
  the exact method that fixes your bug; at level 3, where it is meant to sketch
  the shape in pseudocode, it would write out your corrected function instead.
  Both now hold back and leave you the part that matters. Measured across
  eleven languages.
- Asked to quiz you on a fix you have not actually made yet, the tutor says so
  rather than showing you the fix inside the question.
- One reply began "At hint_level 3, here's the structure:". That is EduPeer's
  own bookkeeping and was never yours to read.

## 1.6.0

- EduPeer works on the block you are in. It used to read the whole file, so it
  could put question marks on functions you had never touched — on files you
  had only just opened, because it also ran on open and on every tab switch.
  Nothing runs now until you land somewhere: rest the cursor in a function, or
  type in it, and that function is what gets looked at.
- Marks you have already earned stay where they are. Moving to another function
  no longer clears the ones behind you.
- Most of your file stays on your machine. What gets sent is your imports, the
  class or function you are inside, the block you are working on and a few
  lines either side — rather than the whole file, which went out on every
  question, every hint and every scan.
- Hints on long files stop guessing at your imports. Past about 120 lines the
  tutor could not see the top of the file at all, so it would tell you an
  import was missing when it was only out of frame.
- `EduPeer: Trace This Code` now asks you to select the code you want traced.
  What you trace is the one thing sent whole rather than trimmed, so it should
  be your choice; it used to guess from wherever the cursor happened to be.
- `EduPeer: Scan File for Issues` is called `EduPeer: Scan This Block`, which
  is what it does.

## 1.5.1

- The first question after a quiet spell no longer fails. The server sleeps
  when nobody has used it for a while and takes up to a minute to wake, which
  was longer than EduPeer was willing to wait — so it gave up and fell back to
  the offline tutor. It now waits out the wake-up, and says that is what it is
  doing instead of leaving you on a spinner.

## 1.5.0

- The hint ladder has a fourth rung, and it is a worked example. Getting stuck
  at hint 3 used to mean the same pseudocode back on every further ask; ask
  again now and you get the concept worked through on a different problem.
  Ask again after that and you get another one.
- The "Show a worked example" button is gone. The ladder reaches it on its
  own, which is where you were most likely to miss the button anyway.
- Ask outright — "just tell me the answer" — and you get it: the bug named on
  its line, only the lines that change, and why the original was wrong. It
  works at any depth and costs you nothing on the ladder.
- The depth chart on the dashboard counts the fourth rung instead of filing it
  under the third, so "needed pseudocode" is no longer overstated.

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
