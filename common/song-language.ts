export const DEFAULT_SONG_LANGUAGE = "hu";

// ISO 639-1 codes, shared by the offline selectors and wire validation.
export const SONG_LANGUAGE_CODES =
  "aa ab ae af ak am an ar as av ay az ba be bg bh bi bm bn bo br bs ca ce ch co cr cs cu cv cy da de dv dz ee el en eo es et eu fa ff fi fj fo fr fy ga gd gl gn gu gv ha he hi ho hr ht hu hy hz ia id ie ig ii ik io is it iu ja jv ka kg ki kj kk kl km kn ko kr ks ku kv kw ky la lb lg li ln lo lt lu lv mg mh mi mk ml mn mr ms mt my na nb nd ne ng nl nn no nr nv ny oc oj om or os pa pi pl ps pt qu rm rn ro ru rw sa sc sd se sg si sk sl sm sn so sq sr ss st su sv sw ta te tg th ti tk tl tn to tr ts tt tw ty ug uk ur uz ve vi vo wa wo xh yi yo za zh zu".split(
    " "
  );
const codes = new Set(SONG_LANGUAGE_CODES);

// A representative flag for each language, not a restriction to that country.
export const SONG_LANGUAGE_COUNTRIES: Readonly<Record<string, string>> = Object.fromEntries(
  "aa:et ab:ge ae:ir af:za ak:gh am:et an:es ar:sa as:in av:ru ay:bo az:az ba:ru be:by bg:bg bh:in bi:vu bm:ml bn:bd bo:cn br:fr bs:ba ca:es ce:ru ch:gu co:fr cr:ca cs:cz cu:bg cv:ru cy:gb da:dk de:de dv:mv dz:bt ee:gh el:gr en:gb es:es et:ee eu:es fa:ir ff:sn fi:fi fj:fj fo:fo fr:fr fy:nl ga:ie gd:gb gl:es gn:py gu:in gv:im ha:ng he:il hi:in ho:pg hr:hr ht:ht hu:hu hy:am hz:na id:id ig:ng ii:cn ik:us is:is it:it iu:ca ja:jp jv:id ka:ge kg:cd ki:ke kj:na kk:kz kl:gl km:kh kn:in ko:kr kr:ng ks:in ku:iq kv:ru kw:gb ky:kg la:va lb:lu lg:ug li:nl ln:cd lo:la lt:lt lu:cd lv:lv mg:mg mh:mh mi:nz mk:mk ml:in mn:mn mr:in ms:my mt:mt my:mm na:nr nb:no nd:zw ne:np ng:na nl:nl nn:no no:no nr:za nv:us ny:mw oc:fr oj:ca om:et or:in os:ge pa:in pi:in pl:pl ps:af pt:pt qu:pe rm:ch rn:bi ro:ro ru:ru rw:rw sa:in sc:it sd:pk se:no sg:cf si:lk sk:sk sl:si sm:ws sn:zw so:so sq:al sr:rs ss:sz st:ls su:id sv:se sw:tz ta:lk te:in tg:tj th:th ti:er tk:tm tl:ph tn:bw to:to tr:tr ts:za tt:ru tw:gh ty:pf ug:cn uk:ua ur:pk uz:uz ve:za vi:vn wa:be wo:sn xh:za yi:il yo:ng za:cn zh:cn zu:za"
    .split(" ")
    .map((entry) => entry.split(":"))
);

export function isSongLanguage(value: unknown): value is string {
  return typeof value === "string" && codes.has(value);
}

export function normalizeSongLanguage(value: unknown): string {
  const code = typeof value === "string" ? value.trim().toLowerCase() : "";
  return isSongLanguage(code) ? code : DEFAULT_SONG_LANGUAGE;
}

// null explicitly selects every language; an empty selection shows no songs.
export function normalizeSongLanguageFilter(value: unknown): string[] | null {
  if (value === null) return null;
  if (!Array.isArray(value)) return [DEFAULT_SONG_LANGUAGE];
  return Array.from(
    new Set(
      value
        .filter((code): code is string => typeof code === "string")
        .map((code) => code.trim().toLowerCase())
        .filter(isSongLanguage)
    )
  );
}

export function matchesSongLanguage(language: unknown, filter: readonly string[] | null): boolean {
  return filter === null || filter.includes(normalizeSongLanguage(language));
}

const displayNames = new Map<string, Intl.DisplayNames>();
export function songLanguageName(code: string, locale: string): string {
  try {
    let names = displayNames.get(locale);
    if (!names) {
      names = new Intl.DisplayNames([locale], { type: "language" });
      displayNames.set(locale, names);
    }
    const name = names.of(code);
    // Some browser locale bundles omit names for less common languages.
    return name && name !== code ? name : locale === "en" ? code : songLanguageName(code, "en");
  } catch {
    return code;
  }
}
