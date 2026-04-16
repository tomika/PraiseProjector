# WYSIWYG ABC Notation Editor — UI Design & Functional Specification

## Overview

A user-friendly, WYSIWYG (What You See Is What You Get) music notation editor built on top of the **abcjs** library, integrated into PraiseProjector's ChordProEditor. The editor allows users to visually compose and edit ABC notation content — inserting, modifying, and deleting notes, rests, chords, bars, text, and other musical elements — without needing to write ABC text directly.

The rendered SVG output from `abcjs.renderAbc()` serves as the interactive editing surface. User actions (clicks, drags, keyboard shortcuts) are translated into ABC text mutations, which are re-rendered in real time.

---

## Architecture

### Core Principle: ABC Text as Source of Truth

All edits operate on the underlying ABC text string. The WYSIWYG surface is a projection of that string via `abcjs.renderAbc()`. Each user interaction:

1. Identifies the target element via `clickListener` / hit testing on SVG elements
2. Maps the SVG element back to a character range in the ABC text (`startChar` / `endChar` from `AbcElem`)
3. Mutates the ABC text at that character range
4. Re-renders via `renderAbc()` to update the visual

### Key abcjs API Features Used

| API | Purpose |
|-----|---------|
| `renderAbc(element, abc, params)` | Render ABC text to SVG in a DOM element |
| `AbcVisualParams.clickListener` | Detect clicks on notes, rests, bars, etc. |
| `AbcVisualParams.add_classes` | Add CSS classes for styling/selection |
| `AbcVisualParams.dragging` | Enable drag interaction for pitch changes |
| `AbcVisualParams.selectionColor` | Visual feedback for selected elements |
| `AbcVisualParams.selectTypes` | Configure which element types are selectable/draggable |
| `AbcVisualParams.dragColor` | Color feedback during drag |
| `AbcElem.startChar / endChar` | Map visual elements back to ABC text positions |
| `AbcElem.pitches` | Read/modify pitch information |
| `AbcElem.duration` | Read/modify note duration |
| `AbcElem.chord` | Read/modify chord annotations |
| `AbcElem.decoration` | Read/modify articulations and dynamics |
| `AbcElem.lyric` | Read/modify lyrics |
| `TuneObject.lines[].staff[].voices[]` | Navigate the parsed tune structure |
| `TuneObject.getElementFromChar(pos)` | Look up elements by character position |
| `TuneObject.findSelectableElement(el)` | Map DOM elements to selectables |
| `TuneObject.getSelectableArray()` | Get all selectable elements for navigation |
| `ClickListenerAnalysis` | Provides staff position, voice, line, measure info |
| `ClickListenerDrag.step` | Pitch drag offset in half steps |
| `strTranspose(abc, visualObj, steps)` | Transpose entire passages |
| `parseOnly(abc)` | Parse without rendering (for validation) |
| `synth.CreateSynth` / `synth.playEvent` | Audio playback and note preview |
| `TimingCallbacks` | Cursor tracking during playback |
| `extractMeasures(abc)` | Parse ABC into measure-level structure |

---

## UI Layout

```
┌─────────────────────────────────────────────────────────────┐
│  ┌─ Toolbar ──────────────────────────────────────────────┐ │
│  │ [Note Dur] [Rest] [♯♭♮] [Tie] [Slur] [Tuplet] [Grace] │ │
│  │ [Bar] [Repeat] [Ending] [Chord] [Lyrics] [Text]        │ │
│  │ [Key] [Time Sig] [Clef] [Tempo] [Dynamics] [Decor]     │ │
│  │ [Undo] [Redo] [Play] [Stop] [Transpose ±]              │ │
│  └─────────────────────────────────────────────────────────┘ │
│                                                              │
│  ┌─ Notation Canvas (SVG rendered by abcjs) ──────────────┐ │
│  │                                                         │ │
│  │   𝄞 4/4  ♩= 120                                        │ │
│  │   ┌───┬───┬───┬───┐┌───┬───┬───┬───┐                   │ │
│  │   │ C │ D │ E │ F ││ G │ A │ B │ c ││                  │ │
│  │   └───┴───┴───┴───┘└───┴───┴───┴───┘                   │ │
│  │     Am      Dm       G7       C                         │ │
│  │   Ama-zing grace, how sweet the sound                   │ │
│  │                                                         │ │
│  │   [cursor blinks at insertion point]                    │ │
│  │   [selected note highlighted in blue]                   │ │
│  │                                                         │ │
│  └─────────────────────────────────────────────────────────┘ │
│                                                              │
│  ┌─ Properties Panel (context-sensitive) ─────────────────┐ │
│  │ Selected: Quarter Note (C4)                             │ │
│  │ Duration: [𝅝][𝅗𝅥][♩][♪][𝅘𝅥𝅯] Dot: [·] [··]            │ │
│  │ Pitch: C4  [▲][▼] Accidental: [♯][♭][♮]                │ │
│  │ Tie: [ ] Staccato: [ ] Accent: [ ] Fermata: [ ]        │ │
│  │ Chord: [____] Lyric: [____]                             │ │
│  └─────────────────────────────────────────────────────────┘ │
│                                                              │
│  ┌─ Status Bar ───────────────────────────────────────────┐ │
│  │ Measure 3 │ Beat 2 │ Voice 1 │ Key: C │ Time: 4/4      │ │
│  └─────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

---

## Toolbar Sections

### 1. Note Input

| Button | Action | ABC Syntax |
|--------|--------|------------|
| 𝅝 Whole | Insert/change to whole note | `C4` |
| 𝅗𝅥 Half | Insert/change to half note | `C2` |
| ♩ Quarter | Insert/change to quarter note | `C` |
| ♪ Eighth | Insert/change to eighth note | `C/2` |
| 𝅘𝅥𝅯 Sixteenth | Insert/change to sixteenth note | `C/4` |
| · Dot | Toggle dotted duration | `C3/2` |
| ·· Double Dot | Toggle double-dotted | `C7/4` |
| Rest | Insert rest of current duration | `z`, `z2`, `z/2` |

**Interaction:** Click a duration button, then click on the staff to place the note at the clicked pitch. Or select an existing note and click a duration to change it.

### 2. Accidentals

| Button | Action | ABC Syntax |
|--------|--------|------------|
| ♯ Sharp | Apply sharp | `^C` |
| ♭ Flat | Apply flat | `_C` |
| ♮ Natural | Apply natural | `=C` |
| 𝄪 Double Sharp | Apply double sharp | `^^C` |
| 𝄫 Double Flat | Apply double flat | `__C` |

### 3. Articulations & Ornaments

| Button | Action | ABC Syntax |
|--------|--------|------------|
| Tie | Connect two notes of same pitch | `C-C` |
| Slur | Start/end slur | `(CDE)` |
| Staccato | Add staccato dot | `.C` |
| Accent | Add accent | `!accent!C` |
| Fermata | Add fermata | `!fermata!C` |
| Tenuto | Add tenuto | `!tenuto!C` |
| Trill | Add trill | `!trill!C` |
| Turn | Add turn | `!turn!C` |
| Mordent | Add mordent | `!mordent!C` |
| Up-bow | Add up-bow | `!upbow!C` |
| Down-bow | Add down-bow | `!downbow!C` |
| Grace Note | Insert grace note(s) before selected note | `{g}C` |

### 4. Tuplets

| Button | Action | ABC Syntax |
|--------|--------|------------|
| Triplet | Group next 3 notes as triplet | `(3CDE` |
| Duplet | Group next 2 notes as duplet | `(2CD` |
| Quadruplet | Group next 4 notes | `(4CDEF` |
| Custom | Dialog: n notes in time of m | `(n:m:l` |

### 5. Bars & Structure

| Button | Action | ABC Syntax |
|--------|--------|------------|
| Bar | Insert barline | `\|` |
| Double Bar | Insert double barline | `\|\|` |
| Final Bar | Insert final barline | `\|]` |
| Start Repeat | Insert start repeat | `\|:` |
| End Repeat | Insert end repeat | `:\|` |
| Double Repeat | Insert double repeat | `:\|:` |
| 1st Ending | Mark first ending | `[1` |
| 2nd Ending | Mark second ending | `[2` |
| Line Break | Force a line break | `\n` in ABC or lineBreaks param |

### 6. Chords & Text

| Button | Action | ABC Syntax |
|--------|--------|------------|
| Chord Symbol | Add/edit chord name above note | `"Am"C` |
| Multi-note Chord | Insert chord (simultaneous notes) | `[CEG]` |
| Lyrics | Add/edit lyrics below staff | `w: text` |
| Free Text | Add text annotation | `"^text"` or `%%text` |
| Part Label | Add part marker | `P:A` |

### 7. Key, Time, Clef & Tempo

| Button | Action | ABC Syntax |
|--------|--------|------------|
| Key Signature | Change key | `K:G`, `K:Dm`, `K:Amix` |
| Time Signature | Change meter | `M:4/4`, `M:3/8`, `M:6/8` |
| Clef | Change clef | `K:... clef=bass` |
| Tempo | Set/change tempo | `Q:1/4=120` |
| Unit Note Length | Change default note length | `L:1/8` |

**Key dialog** shows a dropdown with all supported keys (major, minor, modes: Dorian, Mixolydian, Lydian, Phrygian, Locrian) and accidentals.

**Time signature dialog** shows common options (4/4, 3/4, 6/8, 2/4, C, C|) plus custom numerator/denominator inputs.

### 8. Dynamics

| Button | Action | ABC Syntax |
|--------|--------|------------|
| ppp | Pianississimo | `!ppp!` |
| pp | Pianissimo | `!pp!` |
| p | Piano | `!p!` |
| mp | Mezzo-piano | `!mp!` |
| mf | Mezzo-forte | `!mf!` |
| f | Forte | `!f!` |
| ff | Fortissimo | `!ff!` |
| fff | Fortississimo | `!fff!` |
| sfz | Sforzando | `!sfz!` |
| Crescendo | Start/end crescendo | `!crescendo(!` ... `!crescendo)!` |
| Diminuendo | Start/end diminuendo | `!diminuendo(!` ... `!diminuendo)!` |

### 9. Navigation & Playback

| Button | Action |
|--------|--------|
| Segno | Insert segno mark (`!segno!`) |
| Coda | Insert coda mark (`!coda!`) |
| D.S. | Insert dal segno (`!D.S.!`) |
| D.C. | Insert da capo (`!D.C.!`) |
| Fine | Insert fine mark (`!fine!`) |
| D.S. al Coda | `!D.S.alcoda!` |
| D.C. al Fine | `!D.C.alfine!` |

### 10. Transport Controls

| Button | Action |
|--------|--------|
| ▶ Play | Play from cursor using `synth.CreateSynth` + `TimingCallbacks` |
| ⏹ Stop | Stop playback |
| ⏸ Pause | Pause playback |
| 🔁 Loop | Toggle loop playback |
| Transpose ▲ | Transpose up by semitone via `strTranspose()` |
| Transpose ▼ | Transpose down by semitone via `strTranspose()` |

### 11. Edit Operations

| Button | Action |
|--------|--------|
| Undo | Undo last ABC text change |
| Redo | Redo last undone change |
| Copy | Copy selected ABC region |
| Paste | Paste ABC at cursor |
| Delete | Delete selected element(s) |
| Select All | Select all content |

---

## Interaction Model

### Click to Select

1. User clicks on a note/rest/bar/chord in the rendered SVG
2. `clickListener` callback fires with `AbcElem` data including `startChar`, `endChar`, element type, pitch, duration
3. `ClickListenerAnalysis` provides staff position, voice, line, measure context
4. The element is highlighted using `selectionColor` parameter
5. Properties Panel updates to show the selected element's attributes
6. Status Bar updates with measure number, beat, voice info

### Click to Insert (Note Input Mode)

1. User selects a duration from the toolbar (enters "note input mode")
2. User clicks on the staff at a vertical position
3. The `ClickListenerAnalysis.staffPos` determines pitch from the click's vertical position
4. A new note/rest of the selected duration is inserted into the ABC text at the cursor position (after the currently selected element's `endChar`)
5. The ABC text is re-rendered; the new note is selected

### Drag to Change Pitch

1. With `dragging: true` and `selectTypes: ["note"]` in `AbcVisualParams`
2. User drags a note vertically on the staff
3. `ClickListenerDrag.step` provides the pitch offset in half steps
4. The note's pitch in the ABC text is updated accordingly (e.g., `C` → `D`, or `C` → `^C`)
5. Re-render shows the note at its new position

### Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `←` / `→` | Navigate to previous/next element (using `TuneObject.getSelectableArray()`) |
| `↑` / `↓` | Raise/lower selected note by one step |
| `Shift+↑` / `Shift+↓` | Raise/lower selected note by one octave |
| `1`–`7` | Set duration (whole through 64th) |
| `.` | Toggle dot on selected note |
| `R` | Toggle rest/note |
| `T` | Toggle tie |
| `S` | Toggle slur |
| `Delete` / `Backspace` | Delete selected element |
| `Enter` | Insert barline |
| `Space` | Advance cursor (insert rest of current duration) |
| `Ctrl+Z` | Undo |
| `Ctrl+Shift+Z` / `Ctrl+Y` | Redo |
| `Ctrl+C` | Copy selected range |
| `Ctrl+V` | Paste |
| `Ctrl+A` | Select all |
| `A`–`G` | Insert note with that letter name (in note input mode) |
| `#` | Toggle sharp on selected note |
| `-` | Toggle flat on selected note |
| `=` | Toggle natural on selected note |

### Right-Click Context Menu

Right-clicking on any element shows a context menu with:
- **Edit Properties** — opens the Properties Panel with focus
- **Insert Before/After** — insert element at specific position
- **Delete** — remove the element
- **Copy/Cut/Paste** — clipboard operations
- **Add Chord Symbol** — attach a chord name
- **Add Lyrics** — attach lyric text
- **Add Decoration** — submenu of available decorations
- **Tuplet** — group selected notes into tuplet
- **Beam** — adjust beaming (start beam, end beam, auto)
- **Voice** — move to different voice
- **Transpose** — transpose selected notes by interval

---

## Properties Panel (Inspector)

The Properties Panel is context-sensitive and shows editable properties for the currently selected element.

### Note Properties
- **Pitch**: Note name display with up/down buttons; editable text field
- **Octave**: Octave number with up/down buttons (maps to `,` and `'` in ABC)
- **Duration**: Visual duration selector (whole → 64th) with dot toggles
- **Accidental**: Sharp / Flat / Natural / Double-sharp / Double-flat buttons
- **Stem Direction**: Auto / Up / Down (maps to `[I:stemdir]`)
- **Note Head**: Normal / Harmonic / Rhythm / X / Triangle (maps to `!style:...!`)
- **Beam**: Start beam / End beam / Auto
- **Tied**: Checkbox to tie to next note
- **Decorations**: Multi-select chips for articulations
- **Grace Notes**: List of grace notes before this note
- **Chord Symbol**: Text field for chord name above
- **Lyrics**: Text field for syllable below; divider selector (space / hyphen / underscore)

### Rest Properties
- **Duration**: Duration selector
- **Type**: Normal rest / Spacer / Invisible / Multi-measure

### Bar Properties
- **Bar Type**: Thin / Double / Final / Repeat-start / Repeat-end / Double-repeat
- **Bar Number**: Override bar number
- **Start Ending**: First ending / Second ending
- **End Ending**: Checkbox

### Key/Time/Clef Properties
- **Key**: Root note + accidental + mode dropdowns
- **Time Signature**: Numerator and denominator fields, or common time / cut time toggle
- **Clef**: Dropdown of supported clefs

---

## Multi-Voice Support

The editor supports multiple voices via the `V:` directive:

- **Voice Selector** in the toolbar or status bar shows which voice is active for input
- **Voice Visibility** toggles allow showing/hiding individual voices
- Notes are inserted into the active voice
- `%%staves` directive is managed via a "Staff Layout" dialog for grouping voices

---

## Audio Playback Integration

Playback uses `abcjs.synth.CreateSynth` and `TimingCallbacks`:

1. **Play**: Creates a `MidiBuffer`, calls `init()` → `prime()` → `start()`
2. **Cursor Tracking**: `TimingCallbacks` fires `eventCallback` with `NoteTimingEvent` containing element positions; the editor highlights the current note/beat using `elements` and CSS classes
3. **Note Preview**: When inserting or modifying a note, `synth.playEvent()` plays a short preview of the note sound
4. **Tempo Control**: Warp slider adjusts playback speed via `SynthObjectController.setWarp()`
5. **Sound Font**: Uses the existing PraiseProjector acoustic guitar nylon sound font

---

## Undo/Redo System

- Each ABC text mutation creates an undo entry
- The undo stack stores: `{ abcText: string, cursorPosition: number, selectionRange?: [number, number] }`
- Undo restores the previous ABC text and re-renders
- Redo replays the next mutation
- Groups rapid changes (e.g., drag-pitch adjustments) into single undo entries with debouncing

---

## ABC Text Mutation Helpers

A set of utility functions that manipulate the ABC text string, used by all editing operations:

| Function | Description |
|----------|-------------|
| `insertAtPosition(abc, pos, text)` | Insert ABC text at a character position |
| `replaceRange(abc, start, end, text)` | Replace a character range (from `AbcElem.startChar` to `endChar`) |
| `deleteRange(abc, start, end)` | Remove a character range |
| `changeNotePitch(abc, elem, newPitch)` | Update a note's pitch letter and octave markers |
| `changeNoteDuration(abc, elem, newDuration)` | Update a note's duration (number suffix) |
| `addAccidental(abc, elem, accidental)` | Prepend `^`, `_`, `=`, etc. |
| `addDecoration(abc, elem, decoration)` | Prepend `!decoration!` before a note |
| `addChordSymbol(abc, elem, chord)` | Insert `"ChordName"` before a note |
| `addLyricLine(abc, lineEnd, text)` | Append `w: text` after a music line |
| `insertBarline(abc, pos, type)` | Insert barline of the specified type |
| `wrapInTuplet(abc, startElem, endElem, n)` | Wrap notes in `(n...` tuplet syntax |
| `addGraceNotes(abc, elem, notes)` | Insert `{notes}` before a note |
| `changeKey(abc, pos, key)` | Insert or replace `K:` directive |
| `changeMeter(abc, pos, meter)` | Insert or replace `M:` directive |
| `changeTempo(abc, pos, tempo)` | Insert or replace `Q:` directive |
| `addVoice(abc, voiceId)` | Add a new `V:` voice definition |

All mutations go through `parseOnly()` for validation before applying, to ensure the resulting ABC text is syntactically correct.

---

## Integration with PraiseProjector's ChordPro Editor

The ABC WYSIWYG editor integrates into the existing `ChordProEditor` component:

1. **Activation**: When the cursor is on a `{start_of_abc}...{end_of_abc}` block in the WYSIWYG view, the ABC editor toolbar appears
2. **ABC Container**: Uses the new `abcContainer` DOM overlay (created in this refactoring) to render interactive SVG content
3. **Two-way Sync**: Changes in the WYSIWYG ABC editor update the ChordPro text, and changes in the ChordPro text tab update the ABC editor
4. **Existing Features**: The editor reuses PraiseProjector's existing chord selector, dark mode support, and overlay positioning infrastructure
5. **Scale Support**: The editor works at scale=1 (editing mode) and degrades gracefully to read-only SVG display at other scales (projection mode)

---

## Supported ABC Elements (Complete List)

### Header Fields
| Field | Description | Example |
|-------|-------------|---------|
| `X:` | Reference number | `X:1` |
| `T:` | Title | `T:Amazing Grace` |
| `C:` | Composer | `C:John Newton` |
| `M:` | Meter/Time signature | `M:3/4` |
| `L:` | Default note length | `L:1/8` |
| `K:` | Key signature | `K:G` |
| `Q:` | Tempo | `Q:1/4=100` |
| `V:` | Voice definition | `V:1 name="Soprano"` |
| `P:` | Part marker | `P:A` |
| `R:` | Rhythm type | `R:reel` |
| `W:` | Block lyrics | `W:Amazing grace...` |
| `w:` | Inline lyrics (aligned to notes) | `w:A-ma-zing grace` |

### Notes & Rests
| Element | ABC Syntax | Description |
|---------|------------|-------------|
| Note | `C D E F G A B` | Notes (lowercase = octave up) |
| Octave up | `c d e` or `C'` | Higher octave |
| Octave down | `C, D,` | Lower octave |
| Sharp | `^C` | Sharp |
| Flat | `_B` | Flat |
| Natural | `=F` | Natural |
| Double sharp | `^^C` | Double sharp |
| Double flat | `__B` | Double flat |
| Rest | `z` | Rest |
| Invisible rest | `x` | Spacer |
| Multi-measure rest | `Z4` | 4 measures rest |
| Duration multiplier | `C2` | Half note (double length) |
| Duration divider | `C/2` | Eighth note (half length) |
| Dotted | `C3/2` | Dotted quarter |
| Chord (simultaneous) | `[CEG]` | C major chord |
| Tied notes | `C-C` | Tied |

### Bars & Repeats
| Element | ABC Syntax |
|---------|------------|
| Single bar | `\|` |
| Double bar | `\|\|` |
| Thin-thick | `\|]` |
| Thick-thin | `[\|` |
| Start repeat | `\|:` |
| End repeat | `:\|` |
| Double repeat | `:\|:` |
| First ending | `[1` |
| Second ending | `[2` |
| Invisible bar | `[bar_invisible]` |

### Decorations (All Supported by abcjs)
| Category | Elements |
|----------|----------|
| Articulations | staccato (`.`), accent, tenuto, wedge, marcato |
| Ornaments | trill, turn, turnx, invertedturn, mordent, uppermordent, lowermordent, pralltriller, roll, snap |
| Bowing | upbow, downbow |
| Fingering | 0, 1, 2, 3, 4, 5, + |
| Expressions | fermata, invertedfermata, breath, shortphrase, mediumphrase, longphrase |
| Dynamics | p, pp, ppp, pppp, mp, mf, f, ff, fff, ffff, sfz |
| Hairpins | crescendo(, crescendo), diminuendo(, diminuendo) |
| Glissando | glissando(, glissando) |
| Tremolo | trem1, trem2, trem3, trem4 |
| Repeats | repeatbar, repeatbar2 |
| Rhythm slashes | /, //, ///, //// |
| Navigation | segno, coda, D.S., D.C., fine, D.S.alcoda, D.S.alfine, D.C.alcoda, D.C.alfine |
| Other | open, thumb, slide, arpeggio, xstem, mark, editorial, courtesy |

### Beaming & Grouping
| Element | ABC Syntax |
|---------|------------|
| Auto-beam | Default behavior |
| Break beam | Space between notes |
| Force beam | Backtick `` ` `` between notes |
| Tuplet (triplet) | `(3abc` |
| Grace notes | `{g}C` |
| Acciaccatura | `{/g}C` |
| Slur | `(CDE)` |

### Text & Annotations
| Element | ABC Syntax | Placement |
|---------|------------|-----------|
| Chord symbol | `"Am"C` | Above staff |
| Text above | `"^text"C` | Above note |
| Text below | `"_text"C` | Below note |
| Text left | `"<text"C` | Left of note |
| Text right | `">text"C` | Right of note |
| Free text | `%%text This is text` | Between staves |
| Center text | `%%center Centered text` | Between staves |

### Clefs (Supported by abcjs)
- treble, bass, alto, tenor
- treble+8, treble-8, bass+8, bass-8, alto+8, alto-8, tenor+8, tenor-8
- perc, none

### Modes (for Key Signatures)
- Major (default), Minor (m), Dorian (Dor), Mixolydian (Mix), Lydian (Lyd), Phrygian (Phr), Locrian (Loc)

### MIDI Directives
| Directive | Description |
|-----------|-------------|
| `%%MIDI program N` | Set instrument |
| `%%MIDI channel N` | Set MIDI channel |
| `%%MIDI transpose N` | MIDI transpose |
| `%%MIDI gchord pattern` | Guitar chord pattern |
| `%%MIDI drum pattern` | Drum pattern |
| `%%MIDI tempo N` | Override tempo |

### Tablature Support
- Guitar tablature via `%%tablature` directive
- Mandolin, fiddle/violin tablature
- Custom tuning support

---

## Implementation Phases

### Phase 1: Read-Only Interactive Display
- Render ABC as SVG DOM elements (completed in this PR)
- Click-to-select with highlighting via `clickListener` and `selectionColor`
- Display element info in Properties Panel
- Basic keyboard navigation (arrow keys) via `getSelectableArray()`
- Audio playback with cursor tracking

### Phase 2: Basic Note Editing
- Insert notes by clicking on staff (note input mode)
- Change note pitch via drag (`dragging: true`) or arrow keys
- Change note duration via toolbar buttons or number keys
- Add/remove accidentals
- Delete notes/rests
- Undo/redo system
- Note preview audio on insert/modify

### Phase 3: Bars, Structure & Text
- Insert/delete barlines and repeat signs
- Add endings (1st, 2nd, etc.)
- Insert/edit chord symbols
- Insert/edit lyrics with syllable alignment
- Change key, time signature, clef, tempo
- Add text annotations
- Line break management

### Phase 4: Advanced Features
- Tuplets (triplets, etc.)
- Grace notes
- Slurs and ties
- All decorations and articulations (full decoration palette)
- Dynamics and hairpins
- Copy/paste ABC regions
- Multi-voice editing
- Transpose selected passages
- MIDI directive editing

### Phase 5: Polish & Integration
- Right-click context menus
- Drag-and-drop note reordering
- Smart input (auto-beam, auto-bar-complete)
- Integration with PraiseProjector's song import/export
- Print layout mode
- Tablature view toggle
- Mobile/touch optimizations
- Accessibility (ARIA labels, keyboard-only operation)
