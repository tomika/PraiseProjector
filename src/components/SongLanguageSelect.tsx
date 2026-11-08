import { useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { SONG_LANGUAGE_CODES, SONG_LANGUAGE_COUNTRIES, songLanguageName, toggleSongLanguageFilter } from "../../common/song-language";
import { useLocalization } from "../localization/LocalizationContext";
import flagsUrl from "../assets/song-language-flags.svg";
import "./SongLanguageSelect.css";

type Props = { id?: string; label?: string; disabled?: boolean; frequent?: readonly string[] | null } & (
  | { multiple: true; value: readonly string[] | null; onChange: (value: string[] | null) => void }
  | { multiple?: false; value: string; onChange: (value: string) => void }
);

// Selected languages listed in the closed field, and with remove buttons in the open one.
const CLOSED_SUMMARY_LIMIT = 3;
const OPEN_SUMMARY_LIMIT = 20;

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
  const field = useRef<HTMLDivElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [position, setPosition] = useState({ left: 0, top: 0, width: 280, maxHeight: 320 });
  const isOpen = open && !props.disabled;
  // An empty filter is shown as every language, which is what the setting means.
  const filter = props.multiple && props.value?.length ? props.value : null;

  // Re-enabling must not reopen a list that was open when the control was disabled.
  if (props.disabled && open) setOpen(false);

  // A layout effect places the popup before it is painted, so it never flashes
  // at the viewport's corner.
  useLayoutEffect(() => {
    if (!isOpen) return;
    const place = () => {
      const rect = field.current?.getBoundingClientRect();
      if (!rect) return;
      const width = Math.min(Math.max(rect.width, 280), window.innerWidth - 16);
      const below = window.innerHeight - rect.bottom - 8;
      const above = rect.top - 8;
      const openBelow = below >= Math.min(260, above);
      const maxHeight = Math.max(80, Math.min(360, openBelow ? below : above));
      const next = {
        left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
        top: openBelow ? rect.bottom + 4 : Math.max(8, rect.top - maxHeight - 4),
        width,
        maxHeight,
      };
      setPosition((current) =>
        current.left === next.left && current.top === next.top && current.width === next.width && current.maxHeight === next.maxHeight
          ? current
          : next
      );
    };
    const outside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!field.current?.contains(target) && !popup.current?.contains(target)) setOpen(false);
    };
    // Scrolling the popup's own list does not move the field.
    const scroll = (event: Event) => {
      if (!popup.current?.contains(event.target as Node)) place();
    };
    place();
    searchInput.current?.focus();
    // The remove buttons shown while open, and removing languages, change the field's height.
    const resize = new ResizeObserver(place);
    if (field.current) resize.observe(field.current);
    document.addEventListener("pointerdown", outside);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", scroll, true);
    return () => {
      resize.disconnect();
      document.removeEventListener("pointerdown", outside);
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", scroll, true);
    };
  }, [isOpen]);

  const close = () => {
    setOpen(false);
    toggle.current?.focus();
  };
  // In the filter, the checked languages are the restriction; every language
  // (null) checks only "All". Removing the last language selects every language.
  const selected = (code: string) => (props.multiple ? filter?.includes(code) === true : props.value === code);
  const choose = (code: string) => {
    if (props.multiple) {
      props.onChange(toggleSongLanguageFilter(filter, code));
    } else {
      props.onChange(code);
      close();
    }
  };
  const query = search.trim().toLocaleLowerCase(language);
  const visible = useMemo(
    () =>
      isOpen
        ? SONG_LANGUAGE_CODES.filter(
            (code) => !query || `${code} ${songLanguageName(code, language)}`.toLocaleLowerCase(language).includes(query)
          ).sort((a, b) => songLanguageName(a, language).localeCompare(songLanguageName(b, language), language))
        : [],
    [isOpen, query, language]
  );
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
  const renderSummaryItem = (code: string) => {
    const removeLabel = t("SongLanguageRemove").replace("{0}", songLanguageName(code, language));
    return (
      <span
        className="song-language-summary-item"
        key={code}
        // A near miss of the remove button must not close the list.
        onClick={isOpen ? (event) => event.stopPropagation() : undefined}
      >
        <SongLanguageLabel code={code} />
        {isOpen && (
          <button
            type="button"
            className="song-language-remove"
            tabIndex={-1}
            title={removeLabel}
            aria-label={removeLabel}
            // Keep the focus in the popup's search field.
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => choose(code)}
          >
            ×
          </button>
        )}
      </span>
    );
  };
  const shownCodes = filter?.slice(0, isOpen ? OPEN_SUMMARY_LIMIT : CLOSED_SUMMARY_LIMIT) ?? [];
  const summary = props.multiple ? (
    filter === null ? (
      t("SongLanguagesAll")
    ) : (
      <>
        {shownCodes.map(renderSummaryItem)}
        {filter.length > shownCodes.length && ` +${filter.length - shownCodes.length}`}
      </>
    )
  ) : (
    <SongLanguageLabel code={props.value} />
  );

  return (
    <>
      {/* The whole field opens the list; the toggle button is its keyboard and label target. */}
      <div
        ref={field}
        className={`form-control song-language-trigger${isOpen ? " open" : ""}${props.disabled ? " disabled" : ""}`}
        onClick={() => {
          if (props.disabled) return;
          if (isOpen) {
            close();
          } else {
            setSearch("");
            setOpen(true);
          }
        }}
      >
        <span className="song-language-summary" id={`${id}-summary`}>
          {summary}
        </span>
        <button
          ref={toggle}
          id={id}
          type="button"
          className="song-language-toggle"
          disabled={props.disabled}
          aria-label={props.label ?? t(props.multiple ? "SongLanguageFilter" : "SongLanguage")}
          aria-describedby={`${id}-summary`}
          aria-expanded={isOpen}
          aria-haspopup="dialog"
          aria-controls={isOpen ? `${id}-popup` : undefined}
        >
          <span aria-hidden="true">▾</span>
        </button>
      </div>
      {isOpen &&
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
                close();
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
                {/* "All" is left by checking a language; unchecking it would select nothing. */}
                <input type="checkbox" checked={filter === null} disabled={filter === null} onChange={() => props.onChange(null)} />
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
