# xml2abc-js 122

Copyright 2014–2025 Willem G. Vree and contributors. GNU Lesser General Public
License, as declared in the source header. This component remains LGPL licensed;
the application's PolyForm license does not apply to it.

Source: https://wim.vree.org/js/xml2abc-js_index.html
Archive: https://wim.vree.org/js/xml2abc-js_122.zip
Archive SHA-256: 77d9bdc3de053dcf773a381fea3022a0313cc25e48f30b8a78c3f0326589a11d
Original file: `xml2abc-js_122/full_source/xml2abc.js`.

PraiseProjector modifications:

- ES module import/export with a small XML query adapter replacing jQuery.
- Explicit owner document for empty-staff element construction.
- Unsupported direction types produce diagnostics instead of aborting the score.
- Preserve exact short durations instead of silently rounding their denominator.
- A nested tuplet start without time-modification does not crash the conversion.
- A harmony of kind `none` without display text becomes `N.C.`.

The adjacent TypeScript files implement input validation, MusicXML timewise
normalization, MXL extraction and abcjs output adaptation. The measure reflow and
rest adaptation follow the project's pic2abc implementation. Keep this readable
source and the license texts available when distributing the application. Vite
also emits this complete directory to `third-party/musicxml/` in every build.
