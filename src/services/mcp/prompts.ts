/**
 * MCP prompts: ready-made tasks the user picks in the assistant ("import this picture").
 * A prompt is only text for the model; everything it asks for is done with the tools.
 */
import type { McpHost, McpPrompt } from "./types";

const system = (host: McpHost) => (host.getSettings()?.defaultChordSystem === "S" ? "S" : "G");

const NOTATION: Record<string, string> = {
  G: "German/Hungarian chord notation: H is B natural, B is B flat.",
  S: "standard chord notation: B is B natural, Bb is B flat.",
};

const CHORDPRO_RULES = [
  "ChordPro as this app uses it:",
  "- First line {title: …}. Add what you know for certain as further lines: {artist: …}, {composer: …}, {lyricist: …}, {copyright: …}, {key: …}, {tempo: …}. Leave out what you do not know.",
  "- A chord stands in square brackets inside the lyric line, immediately before the syllable on which it changes: Az [D]Úr irgalma [G]végte[D]len",
  "- A chord after the end of the line goes at the end of the line; a line of chords only is written as [G] [C] [D].",
  "- Sections: {start_of_verse: 1} … {end_of_verse}, {start_of_chorus} … {end_of_chorus}, {start_of_bridge} … {end_of_bridge};",
  "- Write each section once. Where the source repeats one (written out again, or marked 'Refr.', 'Chorus 2x'), put a comment line naming it at that place instead of copying it: {c: Chorus}. Write it between sections, never inside one: there it is not an instruction. The app plays the named section there; the order for a service can also be changed later with playlist instructions.",
  "- Grid sections differs from chordpro standard, here grids contain chords without brackets only, separators (space, pipe, slash, dot etc allowed)",
  "- No empty lines",
].join("\n");

const FINISH = [
  "Before importing:",
  "1. Call search_songs with the title and a distinctive lyric line: if the song is already in the database, tell the user and ask whether to continue.",
  "2. Call validate_chordpro with your text. Chords reported as chordShapedButUnknown or notAChord are not understood by the app: correct them (check_chords shows what the app recognizes) or, if the source really says so, keep them and tell the user.",
  "3. Call import_song with format 'chordpro'. It opens the import wizard in PraiseProjector; nothing is saved until the user finishes there. Tell the user to review the song against the source, and list every place where you were unsure.",
  "If import_song is not allowed, give the ChordPro text to the user and say that 'Allow changes' in Settings → MCP of PraiseProjector lets you open the wizard.",
].join("\n");

export function createMcpPrompts(): McpPrompt[] {
  return [
    {
      name: "import_song_from_picture",
      title: { en: "Import a song from a picture", hu: "Dal importálása képről" },
      description: {
        en: "Transcribes a photo, scan or screenshot of a song sheet (lyrics with chords) attached to the conversation and opens it in PraiseProjector's import wizard.",
        hu: "A beszélgetéshez csatolt kottalap-fotót, szkennelt képet vagy képernyőképet (dalszöveg akkordokkal) átírja, és megnyitja a PraiseProjector importálási varázslójában.",
      },
      arguments: [
        {
          name: "notes",
          description: {
            en: "Anything to know about the picture (several songs, handwriting, which song to take)",
            hu: "Tudnivaló a képről (több dal, kézírás, melyik dal kell)",
          },
          required: false,
        },
      ],
      build: (args, host) =>
        [
          "Import the song sheet in the picture attached to this conversation into PraiseProjector. If no picture is attached, ask for it first.",
          args.notes ? `Notes from the user: ${args.notes}` : "",
          "",
          "Transcribe exactly what the sheet shows:",
          "- Copy the lyrics letter by letter in their own language, with all accents (Hungarian: á é í ó ö ő ú ü ű). Do not translate, do not correct, do not complete the song from memory, do not add lines that are not in the picture.",
          "- Copy every chord, also single letters, and put each before the syllable it stands above. A chord placed a word too early or too late is the most common mistake: compare the horizontal positions carefully.",
          `- Keep the sheet's own chord spelling while reading. The app's chord system is ${system(host)} (${NOTATION[system(host)]}) If the sheet uses the other convention, or lowercase letters for minor chords, convert consistently and tell the user what you converted.`,
          "- If the page holds several songs, ask which one to import, or import them one after the other, each with its own import_song call.",
          "- Mark what you cannot read with (?) and mention it; never guess silently.",
          "",
          CHORDPRO_RULES,
          "",
          FINISH,
        ]
          .filter((line, index) => line || index !== 1)
          .join("\n"),
    },
    {
      name: "import_song_from_recording",
      title: { en: "Import a song from a recording", hu: "Dal importálása hangfelvételről vagy videóról" },
      description: {
        en: "Builds a song for PraiseProjector from an audio or video recording (a file you attach, or a link such as YouTube that identifies the song) and opens it in the import wizard.",
        hu: "Hang- vagy videófelvétel alapján (csatolt fájl, vagy a dalt azonosító hivatkozás, például YouTube) dalt készít a PraiseProjectorhoz, és megnyitja az importálási varázslóban.",
      },
      arguments: [
        {
          name: "source",
          description: { en: "Link to the recording, or what was attached", hu: "A felvétel hivatkozása, vagy hogy mit csatoltál" },
          required: true,
        },
        { name: "title", description: { en: "Title and performer, if known", hu: "Cím és előadó, ha ismert" }, required: false },
      ],
      build: (args, host) =>
        [
          `Import a song into PraiseProjector from this recording: ${args.source || "(the user did not name it: ask)"}`,
          args.title ? `The user says it is: ${args.title}` : "",
          "",
          "What you may and may not do:",
          "- Work from what you can really access: an audio or video file attached to the conversation that you can listen to, a transcript or captions you are able to read, or text the user gives you. Do not download or copy the audio or video of a streaming site (YouTube and similar forbid it in their terms), and do not ask the user to do so.",
          "- A link is still useful: use it to identify the song (title, performer, authors) and keep it in the song as {source: <link>}.",
          "- Be honest about your abilities. If you cannot hear the recording, say so plainly and do not invent lyrics or chords. Then offer what you can do: take the lyrics from the user or from captions you can read, and take chords from a chord sheet the user provides (a picture works too).",
          "- Lyrics and music of most songs are protected by copyright. Remind the user once, briefly, that storing and projecting them needs the usual permission (for churches typically a song licence such as CCLI), and record the authors and the copyright line in the metadata when you know them.",
          "",
          "Steps:",
          "1. Identify the song. Check with search_songs and query_songs (meta: authors or performer) whether it, or another version of it, is already in the database; if so tell the user before doing more.",
          "2. Lyrics: transcribe what is sung, in the sung language, with correct spelling and accents. Write each verse and the chorus once, in the order they first appear, as sections. Mark words you could not make out with (?).",
          `3. Chords: only if you can actually hear the harmony or have a chord source. State the key as {key: …} in the app's chord system ${system(host)} (${NOTATION[system(host)]}) Without a reliable source import the lyrics without chords and say so; the user can add chords in the editor.`,
          "4. Tempo ({tempo: …} in beats per minute) only if you measured it.",
          "",
          CHORDPRO_RULES,
          "",
          FINISH,
        ]
          .filter((line, index) => line || index !== 1)
          .join("\n"),
    },
  ];
}
