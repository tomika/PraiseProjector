/**
 * SchedulePicker — the single, shared "pick a date for a playlist" dialog used by
 * BOTH the Electron desktop GUI and the client-view.
 *
 * It owns the calendar / date-list logic; everything visual and contextual is
 * driven by props so each host supplies its own look and data, exactly like the
 * shared {@link InstructionsEditor}:
 *   - `variant` selects the CSS skin ("desktop" base styling vs the "cv" reskin
 *     applied through the `.schedule-picker--cv` modifier).
 *   - `action` renders the footer buttons as text labels (desktop) or icons (cv).
 *   - All strings are INJECTED (title, weekday names, OK/Cancel, …) — the
 *     component imports no localization context, so the served client-view bundle
 *     can include it.
 *
 * `scheduledDates` are the days that already have a saved playlist; they are
 * "signed" in the calendar (and listed in load mode) so the user can see which
 * dates would overwrite an existing playlist. Desktop feeds this from the local
 * leader schedule, the cloud client from the leader's stored playlists.
 *
 * With `favorites` the dialog shows two tabs: the dated playlists and the named
 * favorite playlists (see common/favorite-playlists). In save mode the favorites
 * tab asks for a name; an existing name overwrites that favorite, a new one gets
 * a free favorite date. `deleteAction` and `favorites.onRename` add the row edit
 * buttons; hosts omit them for read-only leaders.
 *
 * IMPORTANT: this component must stay free of Electron imports.
 */

import { useState, type ReactNode } from "react";
import { formatLocalDateKey } from "../../common/date-only";
import {
  allocateFavoriteDate,
  isFavoriteScheduleDate,
  sameFavoriteName,
  validateFavoriteName,
  type FavoriteNameError,
} from "../../common/favorite-playlists";
import { removeDiacretics } from "../../common/stringTools";
import { weekStartLocale } from "../../common/utils";
import "./SchedulePicker.css";

type ScheduleAction =
  | { style: "text"; okLabel: string; cancelLabel: string }
  | { style: "icon"; okIcon: string; cancelIcon: string; okTitle: string; cancelTitle: string };

export interface ScheduleConfirmOptions {
  shareAfterSave: boolean;
  /** Set when a favorite is saved: the name the user typed (without the ★ prefix). */
  favoriteName?: string;
}

export interface ScheduleShareAction {
  icon: string;
  title: string;
  afterSaveLabel?: string;
  onShare: (date: Date) => void | Promise<void>;
}

export interface ScheduleDeleteAction {
  icon: string;
  title: string;
  /** Deletes the playlist of that date; the host confirms and re-renders the dialog. */
  onDelete: (date: Date) => void | Promise<void>;
}

export interface ScheduleFavoriteItem {
  date: Date;
  /** Display name (without the ★ prefix). */
  name: string;
  /** True when the stored label has no name (an older client replaced it with a
   *  date label): `name` is then only a placeholder, never matched or reused. */
  unnamed?: boolean;
}

export interface ScheduleFavoriteLabels {
  datesTab: string;
  favoritesTab: string;
  nameLabel: string;
  namePlaceholder: string;
  existingHeading: string;
  emptyText: string;
  filterPlaceholder: string;
  renameTitle: string;
  renameSave: string;
  renameCancel: string;
  /** Hint under the name field when the name matches an existing favorite. */
  willOverwrite: string;
  /** Rename error: another favorite already has this name. */
  duplicate: string;
  /** Save error: every favorite slot of the leader is taken. */
  noFreeSlot: string;
  errors: Record<FavoriteNameError, string>;
}

export interface ScheduleFavorites {
  items: ScheduleFavoriteItem[];
  labels: ScheduleFavoriteLabels;
  /** Save mode: asks before overwriting an existing favorite; resolve false to abort. */
  confirmOverwrite?: (item: ScheduleFavoriteItem) => Promise<boolean>;
  /** Renames a favorite; omitted for read-only leaders. */
  onRename?: (date: Date, name: string) => void | Promise<void>;
}

export type ScheduleTab = "dates" | "favorites";

export interface SchedulePickerProps {
  /** Selects the CSS skin: desktop base styling or the client-view reskin. */
  variant: "desktop" | "cv";
  /** "save" shows a calendar to pick any date; "load" lists the scheduled dates. */
  mode: "save" | "load";
  /** Days that already have a saved playlist — marked in the calendar and listed
   *  in load mode. Favorites are passed separately in `favorites`. */
  scheduledDates: Date[];
  /** Pre-selected date (e.g. the date the working list was last saved to/loaded).
   *  A favorite date pre-selects that favorite. */
  initialDate?: Date | null;
  /** Fully-formed dialog title (e.g. "Save playlist for Anna"). */
  title: string;
  /** Short weekday names, Sunday first (length 7) — injected for localization. */
  weekdays: string[];
  /** Label for the "jump to today" button. */
  todayLabel: string;
  /** Shown in load mode when there are no scheduled playlists. */
  noSchedulesText?: string;
  /** Locale for the month/day labels; defaults to the browser locale. */
  locale?: string;
  action: ScheduleAction;
  /** Optional playlist sharing controls for load rows and save confirmation. */
  shareAction?: ScheduleShareAction;
  /** Optional delete button on the listed playlists (dates in load mode and favorites). */
  deleteAction?: ScheduleDeleteAction;
  /** Optional favorites tab. */
  favorites?: ScheduleFavorites;
  /** Tab opened first; defaults to the tab used last. */
  initialTab?: ScheduleTab;
  /**
   * Optional overwrite guard, fired in save mode when the chosen date already has
   * a playlist; resolve false to abort the confirm. Desktop supplies it because
   * its save writes straight to the local schedule with no server round-trip; the
   * cloud client omits it and lets the upload's OVERWRITE response drive the
   * confirm instead.
   */
  confirmOverwrite?: (date: Date) => Promise<boolean>;
  /** Optional host-supplied controls rendered above the calendar/date list —
   *  e.g. the desktop load dialog's leader switcher. Stays a plain ReactNode so
   *  this component remains Electron- and localization-free. */
  headerSlot?: ReactNode;
  onConfirm: (date: Date, options: ScheduleConfirmOptions) => void;
  onCancel: () => void;
}

const TAB_STORAGE_KEY = "pp-schedule-picker-tab";
/** The favorites list gets a filter field above this many entries. */
const FAVORITE_FILTER_THRESHOLD = 8;

function readRememberedTab(): ScheduleTab {
  try {
    return localStorage.getItem(TAB_STORAGE_KEY) === "favorites" ? "favorites" : "dates";
  } catch {
    return "dates";
  }
}

function rememberTab(tab: ScheduleTab): void {
  try {
    localStorage.setItem(TAB_STORAGE_KEY, tab);
  } catch {
    /* ignore */
  }
}

const foldText = (text: string) => removeDiacretics(text).toLocaleLowerCase();

export function SchedulePicker({
  variant,
  mode,
  scheduledDates,
  initialDate,
  title,
  weekdays,
  todayLabel,
  noSchedulesText,
  locale,
  action,
  shareAction,
  deleteAction,
  favorites,
  initialTab,
  confirmOverwrite,
  headerSlot,
  onConfirm,
  onCancel,
}: SchedulePickerProps) {
  const initialFavorite = initialDate ? favorites?.items.find((item) => item.date.getTime() === initialDate.getTime()) : undefined;
  // A favorite date of another leader (the working list may come from one) is
  // not a calendar date: ignore it instead of opening the calendar in 1980.
  const initialDatedDate = initialDate && !isFavoriteScheduleDate(initialDate) ? initialDate : null;

  const [tab, setTab] = useState<ScheduleTab>(() => {
    if (!favorites) return "dates";
    if (initialFavorite) return "favorites";
    return initialTab ?? (initialDatedDate ? "dates" : readRememberedTab());
  });
  const [selectedDate, setSelectedDate] = useState<Date | null>(initialDatedDate);
  const [currentMonth, setCurrentMonth] = useState(initialDatedDate ?? new Date());
  const [shareAfterSave, setShareAfterSave] = useState(false);

  // Favorites tab state.
  const [selectedFavoriteTime, setSelectedFavoriteTime] = useState<number | null>(initialFavorite?.date.getTime() ?? null);
  const [favoriteName, setFavoriteName] = useState(mode === "save" ? (initialFavorite?.name ?? "") : "");
  const [favoriteNameTouched, setFavoriteNameTouched] = useState(false);
  const [favoriteFilter, setFavoriteFilter] = useState("");
  const [renamingTime, setRenamingTime] = useState<number | null>(null);
  const [renameText, setRenameText] = useState("");
  const [renameError, setRenameError] = useState<string | null>(null);
  const [allocationFailed, setAllocationFailed] = useState(false);

  // First day of the week for the active locale (0 = Sun … 6 = Sat), so both the
  // weekday header and the calendar grid start on the locale's first day.
  const localeStr = locale ?? (typeof navigator !== "undefined" ? navigator.language : "en");
  const weekStart = weekStartLocale(localeStr);

  const switchTab = (next: ScheduleTab) => {
    setTab(next);
    rememberTab(next);
  };

  // Check if a date already has a saved playlist.
  const hasSchedule = (date: Date): boolean => {
    const dateKey = formatLocalDateKey(date);
    return scheduledDates.some((d) => formatLocalDateKey(d) === dateKey);
  };

  // Generate calendar days for current month (always 6 weeks = 42 days).
  const getCalendarDays = (): Date[] => {
    const year = currentMonth.getFullYear();
    const month = currentMonth.getMonth();
    const firstDay = new Date(year, month, 1);
    const lastDay = new Date(year, month + 1, 0);
    const days: Date[] = [];

    // Padding days from the previous month — count from the locale's week start.
    const leadingDays = (firstDay.getDay() - weekStart + 7) % 7;
    for (let i = leadingDays - 1; i >= 0; i--) {
      days.push(new Date(year, month, -i));
    }

    // Current month days.
    for (let i = 1; i <= lastDay.getDate(); i++) {
      days.push(new Date(year, month, i));
    }

    // Padding days from the next month to complete 6 weeks (42 days).
    const remainingDays = 42 - days.length;
    for (let i = 1; i <= remainingDays; i++) {
      days.push(new Date(year, month + 1, i));
    }

    return days;
  };

  const handleDateClick = (date: Date) => {
    // Normalize to midnight so equality checks are date-only.
    setSelectedDate(new Date(date.getFullYear(), date.getMonth(), date.getDate()));
  };

  const confirmDate = async (date: Date) => {
    // Favorite dates are never picked from the calendar or the date list.
    if (isFavoriteScheduleDate(date)) return;
    // Load mode requires a date that actually has a schedule.
    if (mode === "load" && !hasSchedule(date)) return;

    // Save mode: confirm before overwriting an existing playlist (desktop only —
    // the cloud client handles overwrite via the upload response).
    if (mode === "save" && confirmOverwrite && hasSchedule(date)) {
      if (!(await confirmOverwrite(date))) return;
    }

    onConfirm(date, { shareAfterSave: mode === "save" && shareAfterSave });
  };

  // ── favorites ────────────────────────────────────────────────────────────────

  const favoriteItems = favorites?.items ?? [];
  const selectedFavorite = favoriteItems.find((item) => item.date.getTime() === selectedFavoriteTime);
  const trimmedFavoriteName = favoriteName.trim();
  const favoriteNameError = validateFavoriteName(favoriteName);
  const matchingFavorite = trimmedFavoriteName
    ? favoriteItems.find((item) => !item.unnamed && sameFavoriteName(item.name, trimmedFavoriteName))
    : undefined;

  const confirmFavoriteLoad = (item: ScheduleFavoriteItem | undefined) => {
    if (!item) return;
    onConfirm(item.date, { shareAfterSave: false });
  };

  const confirmFavoriteSave = async () => {
    if (!favorites) return;
    if (favoriteNameError) {
      setFavoriteNameTouched(true);
      return;
    }
    const options = { shareAfterSave, favoriteName: trimmedFavoriteName };
    if (matchingFavorite) {
      if (favorites.confirmOverwrite && !(await favorites.confirmOverwrite(matchingFavorite))) return;
      onConfirm(matchingFavorite.date, options);
      return;
    }
    let date: Date;
    try {
      date = allocateFavoriteDate(favoriteItems.map((item) => item.date));
    } catch (error) {
      console.error("SchedulePicker", "Cannot allocate a favorite playlist date", error);
      setAllocationFailed(true);
      return;
    }
    onConfirm(date, options);
  };

  const startRename = (item: ScheduleFavoriteItem) => {
    setRenamingTime(item.date.getTime());
    setRenameText(item.unnamed ? "" : item.name);
    setRenameError(null);
  };

  const cancelRename = () => {
    setRenamingTime(null);
    setRenameError(null);
  };

  const commitRename = async (item: ScheduleFavoriteItem) => {
    if (!favorites?.onRename) return;
    const name = renameText.trim();
    const error = validateFavoriteName(name);
    if (error) {
      setRenameError(favorites.labels.errors[error]);
      return;
    }
    if (favoriteItems.some((other) => !other.unnamed && other.date.getTime() !== item.date.getTime() && sameFavoriteName(other.name, name))) {
      setRenameError(favorites.labels.duplicate);
      return;
    }
    if (item.unnamed || name !== item.name) await favorites.onRename(item.date, name);
    cancelRename();
  };

  // ── OK button ────────────────────────────────────────────────────────────────

  const onFavoritesTab = tab === "favorites" && !!favorites;
  // A load-mode date deleted in the dialog stays selected but has no playlist.
  const okDisabled = onFavoritesTab
    ? mode === "load"
      ? !selectedFavorite
      : !!favoriteNameError
    : !selectedDate || isFavoriteScheduleDate(selectedDate) || (mode === "load" && !hasSchedule(selectedDate));

  const handleOK = async () => {
    if (onFavoritesTab) {
      if (mode === "load") confirmFavoriteLoad(selectedFavorite);
      else await confirmFavoriteSave();
      return;
    }
    if (!selectedDate) return;
    await confirmDate(selectedDate);
  };

  const prevMonth = () => setCurrentMonth(new Date(currentMonth.getFullYear(), currentMonth.getMonth() - 1, 1));
  const nextMonth = () => setCurrentMonth(new Date(currentMonth.getFullYear(), currentMonth.getMonth() + 1, 1));
  const goToToday = () => {
    const today = new Date();
    setCurrentMonth(new Date(today.getFullYear(), today.getMonth(), 1));
    handleDateClick(today);
  };

  // ── rendering ────────────────────────────────────────────────────────────────

  const renderShareButton = (date: Date) =>
    shareAction && (
      <button
        type="button"
        className="schedule-share-btn"
        title={shareAction.title}
        aria-label={shareAction.title}
        onClick={(event) => {
          event.stopPropagation();
          void shareAction.onShare(date);
        }}
        onDoubleClick={(event) => event.stopPropagation()}
      >
        <img src={shareAction.icon} alt="" aria-hidden="true" />
      </button>
    );

  const renderDeleteButton = (date: Date) =>
    deleteAction && (
      <button
        type="button"
        className="schedule-share-btn schedule-delete-btn"
        title={deleteAction.title}
        aria-label={deleteAction.title}
        onClick={(event) => {
          event.stopPropagation();
          void deleteAction.onDelete(date);
        }}
        onDoubleClick={(event) => event.stopPropagation()}
      >
        <img src={deleteAction.icon} alt="" aria-hidden="true" />
      </button>
    );

  const renderTabs = () =>
    favorites && (
      <div className="schedule-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={tab === "dates"}
          className={`schedule-tab${tab === "dates" ? " active" : ""}`}
          onClick={() => switchTab("dates")}
        >
          📅 {favorites.labels.datesTab}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "favorites"}
          className={`schedule-tab${tab === "favorites" ? " active" : ""}`}
          onClick={() => switchTab("favorites")}
        >
          ★ {favorites.labels.favoritesTab}
        </button>
      </div>
    );

  const renderCalendar = () => {
    const days = getCalendarDays();
    const monthName = currentMonth.toLocaleDateString(locale, { month: "long", year: "numeric" });

    return (
      <div className="schedule-calendar">
        <div className="calendar-header">
          <button type="button" onClick={prevMonth} className="btn btn-sm calendar-nav-btn">
            ‹
          </button>
          <span className="calendar-month">{monthName}</span>
          <button type="button" onClick={goToToday} className="btn btn-sm btn-outline-secondary calendar-today-btn" title={todayLabel}>
            {todayLabel}
          </button>
          <button type="button" onClick={nextMonth} className="btn btn-sm calendar-nav-btn">
            ›
          </button>
        </div>
        <div className="calendar-weekdays">
          {weekdays.map((_, idx) => (
            <div key={idx} className="calendar-weekday">
              {weekdays[(weekStart + idx) % 7]}
            </div>
          ))}
        </div>
        <div className="calendar-days">
          {days.map((date, idx) => {
            const isCurrentMonth = date.getMonth() === currentMonth.getMonth();
            const isSelected = selectedDate && formatLocalDateKey(date) === formatLocalDateKey(selectedDate);
            const isScheduled = hasSchedule(date);

            return (
              <div
                key={idx}
                className={`calendar-day${!isCurrentMonth ? " other-month" : ""}${isSelected ? " selected" : ""}${isScheduled ? " scheduled" : ""}`}
                onClick={() => isCurrentMonth && handleDateClick(date)}
              >
                {date.getDate()}
              </div>
            );
          })}
        </div>
      </div>
    );
  };

  const renderDateList = () => {
    // Newest first.
    const sortedDates = [...scheduledDates].sort((a, b) => b.getTime() - a.getTime());

    return (
      <div className="schedule-list">
        {sortedDates.length === 0 ? (
          <div className="no-schedules">{noSchedulesText}</div>
        ) : (
          <ul className="date-list">
            {sortedDates.map((date, idx) => {
              const isSelected = selectedDate && formatLocalDateKey(date) === formatLocalDateKey(selectedDate);
              return (
                <li
                  key={`${date.getTime()}-${idx}`}
                  className={`date-item${isSelected ? " selected" : ""}`}
                  onClick={() => setSelectedDate(date)}
                  onDoubleClick={() => {
                    setSelectedDate(date);
                    void confirmDate(date);
                  }}
                >
                  <span className="date-item-label">{date.toLocaleDateString(locale)}</span>
                  {renderShareButton(date)}
                  {renderDeleteButton(date)}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    );
  };

  const renderFavoriteRow = (item: ScheduleFavoriteItem) => {
    if (!favorites) return null;
    const time = item.date.getTime();
    const isSelected = mode === "load" ? time === selectedFavoriteTime : item === matchingFavorite;

    if (renamingTime === time) {
      return (
        <li key={time} className="date-item favorite-item renaming">
          <div className="favorite-rename">
            <div className="favorite-rename-row">
              <input
                type="text"
                className="form-control form-control-sm favorite-rename-input"
                value={renameText}
                autoFocus
                aria-label={favorites.labels.renameTitle}
                onChange={(event) => {
                  setRenameText(event.target.value);
                  setRenameError(null);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void commitRename(item);
                  } else if (event.key === "Escape") {
                    event.preventDefault();
                    event.stopPropagation();
                    cancelRename();
                  }
                }}
              />
              <button
                type="button"
                className="schedule-share-btn"
                title={favorites.labels.renameSave}
                aria-label={favorites.labels.renameSave}
                onClick={() => void commitRename(item)}
              >
                ✓
              </button>
              <button
                type="button"
                className="schedule-share-btn"
                title={favorites.labels.renameCancel}
                aria-label={favorites.labels.renameCancel}
                onClick={cancelRename}
              >
                ✕
              </button>
            </div>
            {renameError && <div className="favorite-error">{renameError}</div>}
          </div>
        </li>
      );
    }

    return (
      <li
        key={time}
        className={`date-item favorite-item${isSelected ? " selected" : ""}`}
        onClick={() => {
          if (mode === "load") setSelectedFavoriteTime(time);
          else if (!item.unnamed) setFavoriteName(item.name);
        }}
        onDoubleClick={() => {
          if (mode === "load") {
            setSelectedFavoriteTime(time);
            confirmFavoriteLoad(item);
          } else if (!item.unnamed) {
            setFavoriteName(item.name);
          }
        }}
      >
        <span className="date-item-label">{item.name}</span>
        {mode === "load" && renderShareButton(item.date)}
        {favorites.onRename && (
          <button
            type="button"
            className="schedule-share-btn schedule-rename-btn"
            title={favorites.labels.renameTitle}
            aria-label={favorites.labels.renameTitle}
            onClick={(event) => {
              event.stopPropagation();
              startRename(item);
            }}
            onDoubleClick={(event) => event.stopPropagation()}
          >
            ✎
          </button>
        )}
        {renderDeleteButton(item.date)}
      </li>
    );
  };

  const renderFavorites = () => {
    if (!favorites) return null;
    const { labels } = favorites;
    const showFilter = mode === "load" && favoriteItems.length > FAVORITE_FILTER_THRESHOLD;
    const filter = showFilter ? foldText(favoriteFilter.trim()) : "";
    const visibleItems = filter ? favoriteItems.filter((item) => foldText(item.name).includes(filter)) : favoriteItems;

    return (
      <div className="schedule-list favorite-list">
        {mode === "save" && (
          <div className="favorite-name-field">
            <label className="favorite-name-label" htmlFor="schedule-favorite-name">
              {labels.nameLabel}
            </label>
            <input
              id="schedule-favorite-name"
              type="text"
              className="form-control favorite-name-input"
              value={favoriteName}
              placeholder={labels.namePlaceholder}
              autoFocus
              onChange={(event) => {
                setFavoriteName(event.target.value);
                setFavoriteNameTouched(true);
                setAllocationFailed(false);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void confirmFavoriteSave();
                }
              }}
            />
            {allocationFailed ? (
              <div className="favorite-error">{labels.noFreeSlot}</div>
            ) : favoriteNameTouched && favoriteNameError ? (
              <div className="favorite-error">{labels.errors[favoriteNameError]}</div>
            ) : (
              matchingFavorite && <div className="favorite-hint">{labels.willOverwrite}</div>
            )}
            {favoriteItems.length > 0 && <div className="favorite-existing-heading">{labels.existingHeading}</div>}
          </div>
        )}
        {showFilter && (
          <input
            type="search"
            className="form-control form-control-sm favorite-filter"
            value={favoriteFilter}
            placeholder={labels.filterPlaceholder}
            aria-label={labels.filterPlaceholder}
            onChange={(event) => setFavoriteFilter(event.target.value)}
          />
        )}
        {favoriteItems.length === 0 ? (
          mode === "load" && <div className="no-schedules">{labels.emptyText}</div>
        ) : (
          <ul className="date-list">{visibleItems.map(renderFavoriteRow)}</ul>
        )}
      </div>
    );
  };

  const cvModifier = variant === "cv" ? " schedule-picker--cv" : "";

  const cancelTitle = action.style === "text" ? action.cancelLabel : action.cancelTitle;

  return (
    <div className={`schedule-dialog-overlay${cvModifier}`} onClick={onCancel}>
      <div className={`schedule-dialog${cvModifier}`} onClick={(e) => e.stopPropagation()}>
        <div className="dialog-header">
          <h3>{title}</h3>
          <button type="button" className="schedule-close-btn" onClick={onCancel} title={cancelTitle} aria-label={cancelTitle}>
            ×
          </button>
        </div>
        <div className="dialog-body">
          {headerSlot}
          {renderTabs()}
          {onFavoritesTab ? renderFavorites() : mode === "save" ? renderCalendar() : renderDateList()}
        </div>
        <div className={`dialog-footer${mode === "save" && shareAction?.afterSaveLabel ? " schedule-dialog-footer--share" : ""}`}>
          {mode === "save" && shareAction?.afterSaveLabel && (
            <label className="schedule-share-after-save">
              <input type="checkbox" checked={shareAfterSave} onChange={(event) => setShareAfterSave(event.target.checked)} />
              <span>{shareAction.afterSaveLabel}</span>
            </label>
          )}
          {action.style === "text" ? (
            <button type="button" className="btn btn-primary schedule-ok-btn" onClick={() => void handleOK()} disabled={okDisabled}>
              {action.okLabel}
            </button>
          ) : (
            <button
              type="button"
              className="schedule-iconbtn schedule-ok-btn"
              title={action.okTitle}
              aria-label={action.okTitle}
              onClick={() => void handleOK()}
              disabled={okDisabled}
            >
              <img className="btnImg" src={action.okIcon} alt={action.okTitle} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export default SchedulePicker;
