import React, { useState } from "react";
import { Leader } from "../../db-common/Leader";
import { useMessageBox } from "../contexts/MessageBoxContext";
import { useLocalization } from "../localization/LocalizationContext";
import { formatLocalDateKey } from "../../common/date-only";
import "./ScheduleDialog.css";

interface ScheduleDialogProps {
  leader: Leader;
  mode: "save" | "load";
  onConfirm: (date: Date) => void;
  onCancel: () => void;
  initialDate?: Date | null;
}

export const ScheduleDialog: React.FC<ScheduleDialogProps> = ({ leader, mode, onConfirm, onCancel, initialDate }) => {
  const { showConfirmAsync } = useMessageBox();
  const { t } = useLocalization();
  const [selectedDate, setSelectedDate] = useState<Date | null>(initialDate ?? null);
  const [currentMonth, setCurrentMonth] = useState(initialDate ?? new Date());

  // Get scheduled dates for this leader
  const scheduledDates = leader.getSchedule();

  // Check if a date has a schedule
  const hasSchedule = (date: Date): boolean => {
    const dateKey = formatLocalDateKey(date);
    return scheduledDates.some((d) => formatLocalDateKey(d) === dateKey);
  };

  // Generate calendar days for current month (always 6 weeks = 42 days)
  const getCalendarDays = (): Date[] => {
    const year = currentMonth.getFullYear();
    const month = currentMonth.getMonth();
    const firstDay = new Date(year, month, 1);
    const lastDay = new Date(year, month + 1, 0);
    const days: Date[] = [];

    // Add padding days from previous month
    const firstDayOfWeek = firstDay.getDay();
    for (let i = firstDayOfWeek - 1; i >= 0; i--) {
      const d = new Date(year, month, -i);
      days.push(d);
    }

    // Add current month days
    for (let i = 1; i <= lastDay.getDate(); i++) {
      days.push(new Date(year, month, i));
    }

    // Add padding days from next month to complete 6 weeks (42 days)
    const remainingDays = 42 - days.length;
    for (let i = 1; i <= remainingDays; i++) {
      days.push(new Date(year, month + 1, i));
    }

    return days;
  };

  const handleDateClick = (date: Date) => {
    // Normalize to midnight
    const normalized = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    setSelectedDate(normalized);
  };

  const handleOK = async () => {
    if (!selectedDate) return;

    // If in load mode, need to have a schedule on this date
    if (mode === "load" && !hasSchedule(selectedDate)) {
      return;
    }

    // If in save mode and date has schedule, confirm overwrite
    if (mode === "save" && hasSchedule(selectedDate)) {
      const dateStr = selectedDate.toLocaleDateString();
      const confirmed = await showConfirmAsync(t("ConfirmOverwrite"), t("AskOverwriteSchedule").replace("{0}", leader.name).replace("{1}", dateStr), {
        confirmText: t("OverwriteScheduleConfirm"),
        confirmDanger: true,
      });
      if (!confirmed) {
        return;
      }
    }

    onConfirm(selectedDate);
  };

  const prevMonth = () => {
    setCurrentMonth(new Date(currentMonth.getFullYear(), currentMonth.getMonth() - 1, 1));
  };

  const nextMonth = () => {
    setCurrentMonth(new Date(currentMonth.getFullYear(), currentMonth.getMonth() + 1, 1));
  };

  const goToToday = () => {
    const today = new Date();
    setCurrentMonth(new Date(today.getFullYear(), today.getMonth(), 1));
    handleDateClick(today);
  };

  // Render save mode (calendar)
  const renderCalendar = () => {
    const days = getCalendarDays();
    const monthName = currentMonth.toLocaleDateString("default", {
      month: "long",
      year: "numeric",
    });

    return (
      <div className="schedule-calendar">
        <div className="calendar-header">
          <button onClick={prevMonth} className="btn btn-sm">
            ‹
          </button>
          <span className="calendar-month">{monthName}</span>
          <button onClick={goToToday} className="btn btn-sm btn-outline-secondary calendar-today-btn" title={t("Today")}>
            {t("Today")}
          </button>
          <button onClick={nextMonth} className="btn btn-sm">
            ›
          </button>
        </div>
        <div className="calendar-weekdays">
          {([t("WeekdaySun"), t("WeekdayMon"), t("WeekdayTue"), t("WeekdayWed"), t("WeekdayThu"), t("WeekdayFri"), t("WeekdaySat")] as const).map(
            (day, idx) => (
              <div key={idx} className="calendar-weekday">
                {day}
              </div>
            )
          )}
        </div>
        <div className="calendar-days">
          {days.map((date, idx) => {
            const isCurrentMonth = date.getMonth() === currentMonth.getMonth();
            const isSelected = selectedDate && formatLocalDateKey(date) === formatLocalDateKey(selectedDate);
            const isScheduled = hasSchedule(date);

            return (
              <div
                key={idx}
                className={`calendar-day ${!isCurrentMonth ? "other-month" : ""} ${isSelected ? "selected" : ""} ${isScheduled ? "scheduled" : ""}`}
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

  // Render load mode (date list)
  const renderDateList = () => {
    // Sort dates in reverse order (newest first)
    const sortedDates = [...scheduledDates].sort((a, b) => b.getTime() - a.getTime());

    return (
      <div className="schedule-list">
        {sortedDates.length === 0 ? (
          <div className="no-schedules">{t("NoScheduledPlaylists").replace("{0}", leader.name)}</div>
        ) : (
          <ul className="date-list">
            {sortedDates.map((date, idx) => {
              const isSelected = selectedDate && formatLocalDateKey(date) === formatLocalDateKey(selectedDate);

              return (
                <li
                  key={idx}
                  className={`date-item ${isSelected ? "selected" : ""}`}
                  onClick={() => setSelectedDate(date)}
                  onDoubleClick={() => {
                    setSelectedDate(date);
                    setTimeout(() => handleOK(), 0);
                  }}
                >
                  {date.toLocaleDateString()}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    );
  };

  return (
    <div className="schedule-dialog-overlay" onClick={onCancel}>
      <div className="schedule-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="dialog-header">
          <h3>
            {mode === "save" ? t("SavePlaylistFor") : t("LoadPlaylistFor")} {leader.name}
          </h3>
        </div>
        <div className="dialog-body">{mode === "save" ? renderCalendar() : renderDateList()}</div>
        <div className="dialog-footer">
          <button className="btn btn-primary" onClick={handleOK} disabled={!selectedDate}>
            {t("OK")}
          </button>
          <button className="btn btn-secondary" onClick={onCancel}>
            {t("Cancel")}
          </button>
        </div>
      </div>
    </div>
  );
};
