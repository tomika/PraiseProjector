# MusicXML import

`convertMusicXml()` accepts MusicXML text; `convertMusicXmlData()` accepts bytes
from `.musicxml`, `.xml` and compressed `.mxl` files. Both return `{ abc, warnings }`.
The UI calls the byte API in a dedicated worker with a 30-second limit and then
uses the existing ABC-to-ChordPro import path. Conversion stays offline.

The core is xml2abc-js 122 (LGPL), with a small XML query adapter instead of
jQuery. Its one-measure-per-line output is adapted using the project's pic2abc
approach: a shared `L:1/8`, synchronized systems across voices, matching lyric
verse rows, repeat/volta continuation and exact-duration gap rests. Unsupported
cross-staff placement, stemless styling and pedals are omitted with notices;
notes and durations remain. Inline fields are placed before decorations so
abcjs does not misread them as note chords.

Input supports both score-partwise and score-timewise, namespace prefixes and
declared XML encodings (including BOM-less UTF-16LE/BE). Voice and lyric verse
IDs are normalized without merging distinct string IDs; part names and metadata
are associated by ID rather than relying on the input body order. Inconsistent
timewise part references and duplicate part IDs are rejected instead of silently
losing music. MXL uses its container manifest, with bounded extraction.
Custom entity declarations, scores over 32 MiB or 100,000 notes and key signatures
beyond seven sharps/flats are rejected explicitly. abcjs parser warnings are
returned for review; successful conversion is not a promise of lossless engraving
of every MusicXML feature.

The adapter follows `pic2abc/pic2abc_core/abcconv.py` but deliberately does not
apply OCR guesses to authored scores (chord-name repairs or deleting lyrics that
look like page footers). All converter code in this directory is distributed
under the GNU Lesser General Public License; see `vendor/COPYING.LESSER` and
`vendor/README.md`. Third-party dependencies retain their own licenses.

Run `npm run test:chordpro` for the import regression tests. The fixture covers
two voices, Hungarian lyrics, sparse second verses, system breaks and repeats.

## Corpus check (2026-11-11)

The implemented byte API was exercised on the original XML/MXL inputs, then
parsed by abcjs 6.6.2. "Clean" below counts abcjs parser warnings only; converter
notices about unsupported placement/style may still be present. These checks do
not establish complete visual or musical equivalence to each original score.

| Corpus | Valid inputs | Converted | Clean in abcjs |
| --- | ---: | ---: | ---: |
| MusicXML test suite (3 intentionally invalid cases excluded) | 182 | 181 | 153 |
| MuseTrainer library | 69 | 69 | 36 |
| OpenScore Lieder (40 evenly spaced entries from sorted paths) | 40 | 40 | 29 |

Pinned input repository trees:

- https://github.com/w3c-cg/musicxmlTestSuite/tree/0618bdee1bfcb965ffdd9f4e52271c909d744fd1
- https://github.com/musetrainer/library/tree/9128876f6164d96997c877a2be843349a32bdabb
- https://github.com/OpenScore/Lieder/tree/38c5db510224d9facdc4b08d741fc788cfb58ea8

The remaining rejected suite case contains signatures beyond seven sharps/flats.
Very short durations and some specialized notation still generate parser
warnings; conversion retains exact timing rather than hiding them by rounding.
