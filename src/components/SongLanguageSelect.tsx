import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { SONG_LANGUAGE_CODES, SONG_LANGUAGE_COUNTRIES, songLanguageName } from "../../common/song-language";
import { useLocalization } from "../localization/LocalizationContext";
import flagsUrl from "../assets/song-language-flags.svg";
import "./SongLanguageSelect.css";

type Props = { id?: string; label?: string; disabled?: boolean; frequent?: readonly string[] | null } & (
  | { multiple: true; value: readonly string[] | null; onChange: (value: string[] | null) => void }
  | { multiple?: false; value: string; onChange: (value: string) => void }
);

export function SongLanguageLabel({ code }: { code: string }) {
  const { language } = useLocalization();
  const country = SONG_LANGUAGE_COUNTRIES[code] ?? (code === "eo" ? "eo" : undefined);
  return (
    <>
      <span className="song-language-flag" aria-hidden="true">
        {country ? (
          <svg viewBox="0 0 36 36">
            <use href={`${flagsUrl}#flag-${country}`} />
          </svg>
        ) : (
          "🌐"
        )}
      </span>
      <span>{songLanguageName(code, language)}</span>
    </>
  );
}

export default function SongLanguageSelect(props: Props) {
  const { t, language } = useLocalization();
  const generatedId = useId();
  const id = props.id ?? generatedId;
  const trigger = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [position, setPosition] = useState({ left: 0, top: 0, width: 280, maxHeight: 320 });

  useEffect(() => {
    if (!open) return;
    const place = () => {
      const rect = trigger.current?.getBoundingClientRect();
      if (!rect) return;
      const width = Math.min(Math.max(rect.width, 280), window.innerWidth - 16);
      const below = window.innerHeight - rect.bottom - 8;
      const above = rect.top - 8;
      const openBelow = below >= Math.min(260, above);
      const maxHeight = Math.max(80, Math.min(360, openBelow ? below : above));
      setPosition({
        left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
        top: openBelow ? rect.bottom + 4 : Math.max(8, rect.top - maxHeight - 4),
        width,
        maxHeight,
      });
    };
    const outside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!trigger.current?.contains(target) && !popup.current?.contains(target)) setOpen(false);
    };
    place();
    searchInput.current?.focus();
    document.addEventListener("pointerdown", outside);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      document.removeEventListener("pointerdown", outside);
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open]);

  const selected = (code: string) => (props.multiple ? props.value === null || props.value.includes(code) : props.value === code);
  const choose = (code: string) => {
    if (props.multiple) {
      const current = props.value ?? SONG_LANGUAGE_CODES;
      const next = selected(code) ? current.filter((value) => value !== code) : [...current, code];
      props.onChange(next.length === SONG_LANGUAGE_CODES.length ? null : next);
    } else {
      props.onChange(code);
      setOpen(false);
      trigger.current?.focus();
    }
  };
  const query = search.trim().toLocaleLowerCase(language);
  const visible = SONG_LANGUAGE_CODES.filter(
    (code) => !query || `${code} ${songLanguageName(code, language)}`.toLocaleLowerCase(language).includes(query)
  ).sort((a, b) => songLanguageName(a, language).localeCompare(songLanguageName(b, language), language));
  const frequent = visible.filter((code) => props.frequent?.includes(code));
  const remaining = visible.filter((code) => !frequent.includes(code));
  const renderCodes = (codes: string[]) =>
    codes.map((code) =>
      props.multiple ? (
        <label className="song-language-option" key={code}>
          <input type="checkbox" checked={selected(code)} onChange={() => choose(code)} />
          <SongLanguageLabel code={code} />
        </label>
      ) : (
        <button type="button" className="song-language-option" key={code} aria-pressed={selected(code)} onClick={() => choose(code)}>
          <SongLanguageLabel code={code} />
          {selected(code) && (
            <span className="ms-auto" aria-hidden="true">
              ✓
            </span>
          )}
        </button>
      )
    );
  const summary = props.multiple ? (
    props.value === null ? (
      t("SongLanguagesAll")
    ) : props.value.length === 0 ? (
      t("SongLanguagesNone")
    ) : (
      props.value.slice(0, 3).map((code) => (
        <span className="song-language-summary-item" key={code}>
          <SongLanguageLabel code={code} />
        </span>
      ))
    )
  ) : (
    <SongLanguageLabel code={props.value} />
  );

  return (
    <>
      <button
        ref={trigger}
        id={id}
        type="button"
        className="form-control song-language-trigger"
        disabled={props.disabled}
        aria-label={props.label ?? t(props.multiple ? "SongLanguageFilter" : "SongLanguage")}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-controls={open ? `${id}-popup` : undefined}
        onClick={() => {
          setSearch("");
          setOpen(!open);
        }}
      >
        <span className="song-language-summary">
          {summary}
          {props.multiple && props.value && props.value.length > 3 && ` +${props.value.length - 3}`}
        </span>
        <span aria-hidden="true">▾</span>
      </button>
      {open &&
        !props.disabled &&
        createPortal(
          <div
            ref={popup}
            id={`${id}-popup`}
            role="dialog"
            aria-labelledby={id}
            className="song-language-popup"
            style={position}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.stopPropagation();
                setOpen(false);
                trigger.current?.focus();
              }
            }}
          >
            <input
              ref={searchInput}
              className="form-control form-control-sm"
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={t("SongLanguageSearch")}
              aria-label={t("SongLanguageSearch")}
            />
            {props.multiple && (
              <label className="song-language-option">
                <input type="checkbox" checked={props.value === null} onChange={(event) => props.onChange(event.target.checked ? null : [])} />
                {t("SongLanguagesAll")}
              </label>
            )}
            <div className="song-language-options">
              {frequent.length > 0 && (
                <>
                  <div className="song-language-group">{t("SongLanguagesFrequent")}</div>
                  {renderCodes(frequent)}
                  <div className="song-language-group">{t("SongLanguagesOther")}</div>
                </>
              )}
              {renderCodes(remaining)}
              {visible.length === 0 && <div className="song-language-group">{t("SongLanguagesNoneFound")}</div>}
            </div>
          </div>,
          document.body
        )}
    </>
  );
}
