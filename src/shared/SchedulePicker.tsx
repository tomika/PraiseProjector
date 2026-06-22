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
 * IMPORTANT: this component must stay free of Electron imports.
 */

import { useState } from "react";
import { formatLocalDateKey } from "../../common/date-only";
import { weekStartLocale } from "../../common/utils";
import "./SchedulePicker.css";

type ScheduleAction =
  | { style: "text"; okLabel: string; cancelLabel: string }
  | { style: "icon"; okIcon: string; cancelIcon: string; okTitle: string; cancelTitle: string };

export interface SchedulePickerProps {
  /** Selects the CSS skin: desktop base styling or the client-view reskin. */
  variant: "desktop" | "cv";
  /** "save" shows a calendar to pick any date; "load" lists the scheduled dates. */
  mode: "save" | "load";
  /** Days that already have a saved playlist — marked in the calendar and listed
   *  in load mode. */
  scheduledDates: Date[];
  /** Pre-selected date (e.g. the date the working list was last saved to/loaded). */
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
  /**
   * Optional overwrite guard, fired in save mode when the chosen date already has
   * a playlist; resolve false to abort the confirm. Desktop supplies it because
   * its save writes straight to the local schedule with no server round-trip; the
   * cloud client omits it and lets the upload's OVERWRITE response drive the
   * confirm instead.
   */
  confirmOverwrite?: (date: Date) => Promise<boolean>;
  onConfirm: (date: Date) => void;
  onCancel: () => void;
}

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
  confirmOverwrite,
  onConfirm,
  onCancel,
}: SchedulePickerProps) {
  const [selectedDate, setSelectedDate] = useState<Date | null>(initialDate ?? null);
  const [currentMonth, setCurrentMonth] = useState(initialDate ?? new Date());

  // First day of the week for the active locale (0 = Sun … 6 = Sat), so both the
  // weekday header and the calendar grid start on the locale's first day.
  const localeStr = locale ?? (typeof navigator !== "undefined" ? navigator.language : "en");
  const weekStart = weekStartLocale(localeStr);

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

  const handleOK = async () => {
    if (!selectedDate) return;

    // Load mode requires a date that actually has a schedule.
    if (mode === "load" && !hasSchedule(selectedDate)) return;

    // Save mode: confirm before overwriting an existing playlist (desktop only —
    // the cloud client handles overwrite via the upload response).
    if (mode === "save" && confirmOverwrite && hasSchedule(selectedDate)) {
      if (!(await confirmOverwrite(selectedDate))) return;
    }

    onConfirm(selectedDate);
  };

  const prevMonth = () => setCurrentMonth(new Date(currentMonth.getFullYear(), currentMonth.getMonth() - 1, 1));
  const nextMonth = () => setCurrentMonth(new Date(currentMonth.getFullYear(), currentMonth.getMonth() + 1, 1));
  const goToToday = () => {
    const today = new Date();
    setCurrentMonth(new Date(today.getFullYear(), today.getMonth(), 1));
    handleDateClick(today);
  };

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
                  key={idx}
                  className={`date-item${isSelected ? " selected" : ""}`}
                  onClick={() => setSelectedDate(date)}
                  onDoubleClick={() => {
                    setSelectedDate(date);
                    setTimeout(() => void handleOK(), 0);
                  }}
                >
                  {date.toLocaleDateString(locale)}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    );
  };

  const cvModifier = variant === "cv" ? " schedule-picker--cv" : "";

  return (
    <div className={`schedule-dialog-overlay${cvModifier}`} onClick={onCancel}>
      <div className={`schedule-dialog${cvModifier}`} onClick={(e) => e.stopPropagation()}>
        <div className="dialog-header">
          <h3>{title}</h3>
        </div>
        <div className="dialog-body">{mode === "save" ? renderCalendar() : renderDateList()}</div>
        <div className="dialog-footer">
          {action.style === "text" ? (
            <>
              <button type="button" className="btn btn-primary schedule-ok-btn" onClick={() => void handleOK()} disabled={!selectedDate}>
                {action.okLabel}
              </button>
              <button type="button" className="btn btn-secondary schedule-cancel-btn" onClick={onCancel}>
                {action.cancelLabel}
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                className="schedule-iconbtn schedule-cancel-btn"
                title={action.cancelTitle}
                aria-label={action.cancelTitle}
                onClick={onCancel}
              >
                <img className="btnImg" src={action.cancelIcon} alt={action.cancelTitle} />
              </button>
              <button
                type="button"
                className="schedule-iconbtn schedule-ok-btn"
                title={action.okTitle}
                aria-label={action.okTitle}
                onClick={() => void handleOK()}
                disabled={!selectedDate}
              >
                <img className="btnImg" src={action.okIcon} alt={action.okTitle} />
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export default SchedulePicker;
