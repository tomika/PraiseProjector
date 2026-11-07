import React from "react";
import { useSettings } from "../hooks/useSettings";
import { getAssetPath } from "../utils/assetPath";

export enum IconType {
  // Toolbar icons
  SYNC = "sync",
  LOAD = "load",
  SAVE = "save",
  NEW = "new",
  IMPORT = "import",
  PRINT = "print",
  VIEWER = "viewer",
  SETTINGS = "settings",

  // Playlist icons
  MOVE_UP = "move_up",
  MOVE_DOWN = "move_down",
  TRANSPOSE_UP = "transpose_up",
  TRANSPOSE_DOWN = "transpose_down",
  CAPO_UP = "capo_up",
  CAPO_DOWN = "capo_down",
  REMOVE = "remove",
  EDIT = "edit",
  ADD = "add",

  // Preview panel icons
  BOLD = "bold",
  ITALIC = "italic",
  UNDERLINE = "underline",
  ALIGN_LEFT = "align_left",
  ALIGN_CENTER = "align_center",
  ALIGN_RIGHT = "align_right",
  DISPLAY = "display",
  BG_COLOR = "bg_color",
  TEXT = "text",
  IMAGE = "image",
  MESSAGE = "message",
  CONTENT_FORMAT = "content_format",
  INSTRUCTIONS = "instructions",
  REMOTE_CONTROL = "remote_control",
  FREEZE = "freeze",

  // Editor panel icons
  TITLE = "title",
  VERSE = "verse",
  CHORUS = "chorus",
  BRIDGE = "bridge",
  GRID = "grid",
  COMMENT = "comment",
  NOTATION = "notation",
  SHIFT_UP = "shift_up",
  SHIFT_DOWN = "shift_down",

  // Other icons
  USER = "user",
  LEADER = "leader",
  CLEAR = "clear",
  SESSIONS = "sessions",

  // Song tree icons
  FOLDER = "folder",
  MUSIC = "music",
  TEXT_ONLY = "text_only",
  ALERT = "alert",
  STARRED_MUSIC = "starred_music",
  STARRED_TEXT = "starred_text",
  SCORE = "score",
  STARRED_SCORE = "starred_score",
  HEART_EMPTY = "heart_empty",
  HEART_FILLED = "heart_filled",
  HEART_IGNORED = "heart_ignored",
  BIG_HEART_EMPTY = "big_heart_empty",
  BIG_HEART_FILLED = "big_heart_filled",
  CLOUD_ACCESS_FAILED = "cloud_access_failed",

  // Inline search option icons
  SEARCH_FUZZY = "search_fuzzy",
  SEARCH_CASE = "search_case",
  SEARCH_WHOLE_WORD = "search_whole_word",

  // Monochrome indicators
  CHECKBOX_CHECKED = "checkbox_checked",
  CHECKBOX_EMPTY = "checkbox_empty",

  // Filter / visibility
  EYE = "eye",
}

interface IconConfig {
  faIcon?: string;
  faContent?: React.ReactNode;
  imagePath?: string;
  alt: string;
}

// Treble clef outline: the "clefs.G" glyph of abcjs (MIT, src/write/creation/glyphs.js),
// so the song-tree score icon matches the clef drawn in rendered scores.
// Bounding box: x 0..19.1, y -37.5..19.6.
const TREBLE_CLEF_PATH =
  "M9.69 -37.41c0.09 -0.09 0.24 -0.06 0.36 0c0.12 0.09 0.57 0.6 0.96 1.11c1.77 2.34 3.21 5.85 3.57 8.73c0.21 1.56 0.03 3.27 -0.45 4.86c-0.69 2.31 -1.92 4.47 -4.23 7.44c-0.3 0.39 -0.57 0.72 -0.6 0.75c-0.03 0.06 0 0.15 0.18 0.78c0.54 1.68 1.38 4.44 1.68 5.49l0.09 0.42l0.39 0c1.47 0.09 2.76 0.51 3.96 1.29c1.83 1.23 3.06 3.21 3.39 5.52c0.09 0.45 0.12 1.29 0.06 1.74c-0.09 1.02 -0.33 1.83 -0.75 2.73c-0.84 1.71 -2.28 3.06 -4.02 3.72l-0.33 0.12l0.03 1.26c0 1.74 -0.06 3.63 -0.21 4.62c-0.45 3.06 -2.19 5.49 -4.47 6.21c-0.57 0.18 -0.9 0.21 -1.59 0.21c-0.69 0 -1.02 -0.03 -1.65 -0.21c-1.14 -0.27 -2.13 -0.84 -2.94 -1.65c-0.99 -0.99 -1.56 -2.16 -1.71 -3.54c-0.09 -0.81 0.06 -1.53 0.45 -2.13c0.63 -0.99 1.83 -1.56 3 -1.53c1.5 0.09 2.64 1.32 2.73 2.94c0.06 1.47 -0.93 2.7 -2.37 2.97c-0.45 0.06 -0.84 0.03 -1.29 -0.09l-0.21 -0.09l0.09 0.12c0.39 0.54 0.78 0.93 1.32 1.26c1.35 0.87 3.06 1.02 4.35 0.36c1.44 -0.72 2.52 -2.28 2.97 -4.35c0.15 -0.66 0.24 -1.5 0.3 -3.03c0.03 -0.84 0.03 -2.94 0 -3c-0.03 0 -0.18 0 -0.36 0.03c-0.66 0.12 -0.99 0.12 -1.83 0.12c-1.05 0 -1.71 -0.06 -2.61 -0.3c-4.02 -0.99 -7.11 -4.35 -7.8 -8.46c-0.12 -0.66 -0.12 -0.99 -0.12 -1.83c0 -0.84 0 -1.14 0.15 -1.92c0.36 -2.28 1.41 -4.62 3.3 -7.29l2.79 -3.6c0.54 -0.66 0.96 -1.2 0.96 -1.23c0 -0.03 -0.09 -0.33 -0.18 -0.69c-0.96 -3.21 -1.41 -5.28 -1.59 -7.68c-0.12 -1.38 -0.15 -3.09 -0.06 -3.96c0.33 -2.67 1.38 -5.07 3.12 -7.08c0.36 -0.42 0.99 -1.05 1.17 -1.14zm2.01 4.71c-0.15 -0.3 -0.3 -0.54 -0.3 -0.54c-0.03 0 -0.18 0.09 -0.3 0.21c-2.4 1.74 -3.87 4.2 -4.26 7.11c-0.06 0.54 -0.06 1.41 -0.03 1.89c0.09 1.29 0.48 3.12 1.08 5.22c0.15 0.42 0.24 0.78 0.24 0.81c0 0.03 0.84 -1.11 1.23 -1.68c1.89 -2.73 2.88 -5.07 3.15 -7.53c0.09 -0.57 0.12 -1.74 0.06 -2.37c-0.09 -1.23 -0.27 -1.92 -0.87 -3.12zm-2.94 20.7c-0.21 -0.72 -0.39 -1.32 -0.42 -1.32c0 0 -1.2 1.47 -1.86 2.37c-2.79 3.63 -4.02 6.3 -4.35 9.3c-0.03 0.21 -0.03 0.69 -0.03 1.08c0 0.69 0 0.75 0.06 1.11c0.12 0.54 0.27 0.99 0.51 1.47c0.69 1.38 1.83 2.55 3.42 3.42c0.96 0.54 2.07 0.9 3.21 1.08c0.78 0.12 2.04 0.12 2.94 -0.03c0.51 -0.06 0.45 -0.03 0.42 -0.3c-0.24 -3.33 -0.72 -6.33 -1.62 -10.08c-0.09 -0.39 -0.18 -0.75 -0.18 -0.78c-0.03 -0.03 -0.42 0 -0.81 0.09c-0.9 0.18 -1.65 0.57 -2.22 1.14c-0.72 0.72 -1.08 1.65 -1.05 2.64c0.06 0.96 0.48 1.83 1.23 2.58c0.36 0.36 0.72 0.63 1.17 0.9c0.33 0.18 0.36 0.21 0.42 0.33c0.18 0.42 -0.18 0.9 -0.6 0.87c-0.18 -0.03 -0.84 -0.36 -1.26 -0.63c-0.78 -0.51 -1.38 -1.11 -1.86 -1.83c-1.77 -2.7 -0.99 -6.42 1.71 -8.19c0.3 -0.21 0.81 -0.48 1.17 -0.63c0.3 -0.09 1.02 -0.3 1.14 -0.3c0.06 0 0.09 0 0.09 -0.03c0.03 -0.03 -0.51 -1.92 -1.23 -4.26zm3.78 7.41c-0.18 -0.03 -0.36 -0.06 -0.39 -0.06c-0.03 0 0 0.21 0.18 1.02c0.75 3.18 1.26 6.3 1.5 9.09c0.06 0.72 0 0.69 0.51 0.42c0.78 -0.36 1.44 -0.96 1.98 -1.77c1.08 -1.62 1.2 -3.69 0.3 -5.55c-0.81 -1.62 -2.31 -2.79 -4.08 -3.15z";

// At song-tree size (16px) the engraved glyph is too thin to read, so the icon
// widens it 1.45x around its centre and outlines it with a 3.2-unit stroke
// (heavier settings fill the clef's loops in). Bold bounding box: x -5.9..25.0,
// y -39.1..21.2.
const BoldTrebleClef: React.FC = () => (
  <g transform="translate(9.5 0) scale(1.45 1) translate(-9.5 0)">
    <path d={TREBLE_CLEF_PATH} stroke="currentColor" strokeWidth="3.2" strokeLinejoin="round" />
  </g>
);

const iconMap: Record<IconType, IconConfig> = {
  // Toolbar
  [IconType.SYNC]: { faIcon: "fa fa-cloud", imagePath: "assets/cloud.png", alt: "Sync" },
  [IconType.LOAD]: {
    faIcon: "fa fa-folder-open",
    imagePath: "assets/load.png",
    alt: "Load",
  },
  [IconType.SAVE]: { faIcon: "fa fa-save", imagePath: "assets/save.png", alt: "Save" },
  [IconType.NEW]: { faIcon: "fa fa-plus", imagePath: "assets/add.png", alt: "New" },
  [IconType.IMPORT]: { faIcon: "fa fa-download", imagePath: "assets/import.png", alt: "Import" },
  [IconType.PRINT]: { faIcon: "fa fa-print", imagePath: "assets/print.png", alt: "Print" },
  [IconType.VIEWER]: { faIcon: "fa fa-tablet", imagePath: "assets/tablet.png", alt: "Viewer" },
  [IconType.SETTINGS]: {
    faIcon: "fa fa-cog",
    imagePath: "assets/settings.png",
    alt: "Settings",
  },

  // Playlist
  [IconType.MOVE_UP]: {
    faIcon: "fa fa-arrow-up",
    imagePath: "assets/arrow_up.png",
    alt: "Up",
  },
  [IconType.MOVE_DOWN]: {
    faIcon: "fa fa-arrow-down",
    imagePath: "assets/arrow_down.png",
    alt: "Down",
  },
  [IconType.TRANSPOSE_UP]: {
    faContent: (
      <svg className="pp-svg-icon" viewBox="0 0 40 40" fill="currentColor">
        <text x="1" y="25" fontSize="30" fontFamily="serif" fill="currentColor">
          ♪
        </text>
        <path d="M26 22 L26 8 M22 12 L26 8 L30 12" stroke="currentColor" strokeWidth="3" fill="none" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
    imagePath: "assets/shift_up.png",
    alt: "T+",
  },
  [IconType.TRANSPOSE_DOWN]: {
    faContent: (
      <svg className="pp-svg-icon" viewBox="0 0 40 40" fill="currentColor">
        <text x="1" y="25" fontSize="30" fontFamily="serif" fill="currentColor">
          ♪
        </text>
        <path d="M26 8 L26 22 M22 18 L26 22 L30 18" stroke="currentColor" strokeWidth="3" fill="none" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
    imagePath: "assets/shift_down.png",
    alt: "T-",
  },
  [IconType.CAPO_UP]: {
    faContent: (
      <svg className="pp-svg-icon" viewBox="0 0 40 40" fill="currentColor">
        {/* F/K hybrid capo body */}
        <rect x="0" y="2" width="6" height="28" rx="2" />
        <rect x="4" y="2" width="16" height="5" rx="2" />
        <rect x="4" y="10" width="14" height="4" rx="2" />
        <path d="M10 14 L16 26" stroke="currentColor" strokeWidth="4" strokeLinecap="round" />
        {/* Up arrow, spaced right */}
        <path d="M28 26 L28 10 M24 14 L28 10 L32 14" stroke="currentColor" strokeWidth="3" fill="none" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
    imagePath: "assets/capo_up.png",
    alt: "C+",
  },
  [IconType.CAPO_DOWN]: {
    faContent: (
      <svg className="pp-svg-icon" viewBox="0 0 40 40" fill="currentColor">
        {/* F/K hybrid capo body */}
        <rect x="0" y="2" width="6" height="28" rx="2" />
        <rect x="4" y="2" width="16" height="5" rx="2" />
        <rect x="4" y="10" width="14" height="4" rx="2" />
        <path d="M10 14 L16 26" stroke="currentColor" strokeWidth="4" strokeLinecap="round" />
        {/* Down arrow, spaced right */}
        <path d="M28 10 L28 26 M24 22 L28 26 L32 22" stroke="currentColor" strokeWidth="3" fill="none" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
    imagePath: "assets/capo_down.png",
    alt: "C-",
  },
  [IconType.REMOVE]: {
    faIcon: "fa fa-minus",
    imagePath: "assets/delete.png",
    alt: "Remove",
  },
  [IconType.EDIT]: { faIcon: "fa fa-pencil", imagePath: "assets/modify.png", alt: "Edit" },
  [IconType.ADD]: { faIcon: "fa fa-plus", imagePath: "assets/add.png", alt: "Add" },

  // Preview panel
  [IconType.BOLD]: {
    faIcon: "fa fa-bold",
    imagePath: "assets/bold.png",
    alt: "Bold",
  },
  [IconType.ITALIC]: {
    faIcon: "fa fa-italic",
    imagePath: "assets/italic.png",
    alt: "Italic",
  },
  [IconType.UNDERLINE]: {
    faIcon: "fa fa-underline",
    imagePath: "assets/underline.png",
    alt: "Underline",
  },
  [IconType.ALIGN_LEFT]: {
    faIcon: "fa fa-align-left",
    imagePath: "assets/align_left.png",
    alt: "Align Left",
  },
  [IconType.ALIGN_CENTER]: {
    faIcon: "fa fa-align-center",
    imagePath: "assets/align_center.png",
    alt: "Align Center",
  },
  [IconType.ALIGN_RIGHT]: {
    faIcon: "fa fa-align-right",
    imagePath: "assets/align_right.png",
    alt: "Align Right",
  },
  [IconType.DISPLAY]: {
    faIcon: "fa fa-desktop",
    imagePath: "assets/projector-icon.png",
    alt: "Display",
  },
  [IconType.BG_COLOR]: {
    faIcon: "fa fa-paint-brush",
    imagePath: "assets/bgcolor.png",
    alt: "BG Color",
  },
  [IconType.TEXT]: {
    faIcon: "fa fa-font",
    imagePath: "assets/text.png",
    alt: "Text",
  },
  [IconType.IMAGE]: { faIcon: "fa fa-image", imagePath: "assets/image.png", alt: "Image" },
  [IconType.MESSAGE]: {
    faIcon: "fa fa-comment",
    imagePath: "assets/message.png",
    alt: "Message",
  },
  [IconType.CONTENT_FORMAT]: {
    faIcon: "fa fa-align-left",
    imagePath: "assets/content_format.png",
    alt: "Content Format",
  },
  [IconType.INSTRUCTIONS]: {
    faIcon: "fa fa-info-circle",
    imagePath: "assets/instructions.png",
    alt: "Instructions",
  },
  [IconType.REMOTE_CONTROL]: {
    faContent: (
      <svg
        className="pp-svg-icon pp-svg-icon-dense"
        viewBox="0 0 48 48"
        fill="none"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M10 10 Q24 -2 38 10" />
        <path d="M16 14 Q24 7 32 14" />
        <rect x="12" y="18" width="24" height="28" rx="6" />
        <circle cx="24" cy="27" r="5" />
        <circle cx="19" cy="37" r="2" fill="currentColor" stroke="none" />
        <circle cx="29" cy="37" r="2" fill="currentColor" stroke="none" />
        <circle cx="19" cy="42" r="2" fill="currentColor" stroke="none" />
        <circle cx="29" cy="42" r="2" fill="currentColor" stroke="none" />
      </svg>
    ),
    imagePath: "assets/remote-control.png",
    alt: "Remote Control",
  },
  [IconType.FREEZE]: {
    faIcon: "fa fa-snowflake-o",
    imagePath: "assets/snowflake.png",
    alt: "Freeze",
  },

  // Editor panel
  [IconType.TITLE]: { faContent: "Title", imagePath: "assets/title.png", alt: "Title" },
  [IconType.VERSE]: {
    faIcon: "fa fa-user",
    imagePath: "assets/conductor.png",
    alt: "Verse",
  },
  [IconType.CHORUS]: {
    faIcon: "fa fa-users",
    imagePath: "assets/chorus.png",
    alt: "Chorus",
  },
  [IconType.BRIDGE]: {
    faContent: (
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 500 500"
        fill="none"
        stroke="currentColor"
        strokeWidth="38"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <line x1="28.988" y1="314.324" x2="468.436" y2="313.16"></line>
        <line x1="126.772" y1="30.28" x2="128.518" y2="467.986"></line>
        <line x1="365.412" y1="32.026" x2="366.576" y2="469.733"></line>
        <path d="M 127.244 27.952 C 128.388 313.616 367.136 312.7 364.139 27.952"></path>
        <path d="M 25.967 313.16 L 126.08 27.952"></path>
        <path d="M 471.818 313.742 L 364.721 28.534"></path>
      </svg>
    ),
    imagePath: "assets/bridge.png",
    alt: "Bridge",
  },
  [IconType.GRID]: {
    faContent: (
      <svg
        className="pp-svg-icon pp-svg-icon-dense"
        viewBox="0 0 40 40"
        fill="none"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {/* Note dot */}
        <circle cx="4" cy="22" r="3" fill="currentColor" stroke="none" />
        {/* Stem line */}
        <path d="M7 22 H16" />
        {/* Chord box */}
        <rect x="16" y="16" width="10" height="10" rx="2" />
        {/* Dots above chord box */}
        <circle cx="19" cy="13" r="1.5" fill="currentColor" stroke="none" />
        <circle cx="22" cy="13" r="1.5" fill="currentColor" stroke="none" />
        <circle cx="25" cy="13" r="1.5" fill="currentColor" stroke="none" />
        {/* Bell connector */}
        <rect x="26" y="20.5" width="6" height="1" rx="2" />
        {/* Bell flare */}
        <path d="M32 21 L40 14 L40 28 L32 21 Z" fill="currentColor" stroke="none" />
      </svg>
    ),
    imagePath: "assets/trumpet.png",
    alt: "Grid",
  },
  [IconType.COMMENT]: {
    faIcon: "fa fa-comment-o",
    imagePath: "assets/comment.png",
    alt: "Comment",
  },
  [IconType.NOTATION]: {
    faIcon: "fa fa-music",
    imagePath: "assets/notation.png",
    alt: "ABC notation",
  },
  [IconType.SHIFT_UP]: { faIcon: "fa fa-arrow-up", imagePath: "assets/shift_up.png", alt: "Up" },
  [IconType.SHIFT_DOWN]: {
    faIcon: "fa fa-arrow-down",
    imagePath: "assets/shift_down.png",
    alt: "Down",
  },

  // Other
  [IconType.USER]: { faIcon: "fa fa-user", imagePath: "assets/user.png", alt: "User" },
  [IconType.LEADER]: { faIcon: "fa fa-user-circle", imagePath: "assets/leader.png", alt: "Leader" },
  [IconType.CLEAR]: { faIcon: "fa fa-times", imagePath: "assets/clear.png", alt: "Clear" },
  [IconType.SESSIONS]: { faIcon: "fa fa-wifi", imagePath: "assets/wifi.png", alt: "Sessions" },

  // Song tree
  [IconType.FOLDER]: { faIcon: "fa fa-folder", imagePath: "assets/folder.png", alt: "Folder" },
  [IconType.MUSIC]: { faIcon: "fa fa-music", imagePath: "assets/music.png", alt: "Music" },
  [IconType.TEXT_ONLY]: {
    faIcon: "fa fa-file-text-o",
    alt: "Text Only",
  },
  [IconType.ALERT]: {
    faIcon: "fa fa-exclamation-triangle",
    imagePath: "assets/alert.png",
    alt: "Alert",
  },
  [IconType.STARRED_MUSIC]: {
    faIcon: "fa fa-star",
    imagePath: "assets/starred_music.png",
    alt: "Starred Music",
  },
  [IconType.STARRED_TEXT]: {
    faIcon: "fa fa-star",
    imagePath: "assets/starred_text.png",
    alt: "Starred Text",
  },
  // No PNG variant: the SVG renders in both icon modes and follows the text colour.
  [IconType.SCORE]: {
    faContent: (
      <svg className="pp-score-icon" viewBox="-11 -41.5 41 64" fill="currentColor" role="img" aria-label="Score">
        <BoldTrebleClef />
      </svg>
    ),
    alt: "Score",
  },
  [IconType.STARRED_SCORE]: {
    faContent: (
      <svg className="pp-score-icon" viewBox="-36 -41.5 64 64" fill="currentColor" role="img" aria-label="Starred Score">
        <BoldTrebleClef />
        <polygon
          points="-20.5 -40.5 -16.9 -30.5 -6.2 -30.1 -14.6 -23.6 -11.7 -13.4 -20.5 -19.3 -29.3 -13.4 -26.4 -23.6 -34.8 -30.1 -24.1 -30.5"
          fill="#ffc107"
          stroke="#b07800"
          strokeWidth="1.6"
          strokeLinejoin="round"
        />
      </svg>
    ),
    alt: "Starred Score",
  },
  [IconType.HEART_EMPTY]: {
    faIcon: "fa fa-heart-o",
    faContent: (
      <svg className="pp-svg-icon pp-svg-icon-sm" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path
          d="M8 14s-5.5-3.5-6.5-7C.5 3.5 3 1 5.5 1.5 7 1.8 8 3 8 3s1-1.2 2.5-1.5C13 1 15.5 3.5 14.5 7 13.5 10.5 8 14 8 14z"
          strokeLinejoin="round"
        />
      </svg>
    ),
    alt: "Not Preferred",
  },
  [IconType.HEART_FILLED]: {
    faIcon: "fa fa-heart",
    faContent: (
      <svg className="pp-svg-icon pp-svg-icon-sm" viewBox="0 0 16 16" fill="currentColor">
        <path d="M8 14s-5.5-3.5-6.5-7C.5 3.5 3 1 5.5 1.5 7 1.8 8 3 8 3s1-1.2 2.5-1.5C13 1 15.5 3.5 14.5 7 13.5 10.5 8 14 8 14z" />
      </svg>
    ),
    alt: "Preferred",
  },
  [IconType.HEART_IGNORED]: {
    faIcon: "fa fa-times",
    faContent: "\u2716",
    alt: "Ignored",
  },
  [IconType.BIG_HEART_EMPTY]: {
    faIcon: "fa fa-heart-o",
    imagePath: "assets/heart_empty.png",
    alt: "Not Preferred",
  },
  [IconType.BIG_HEART_FILLED]: {
    faIcon: "fa fa-heart",
    imagePath: "assets/heart_filled.png",
    alt: "Preferred",
  },
  [IconType.CLOUD_ACCESS_FAILED]: {
    faContent: (
      <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" fill="currentColor" viewBox="0 0 16 16">
        <path d="M 3.759 1.574 C 3.541 1.255 2.83 0.835 2.662 1.182 C 2.585 1.344 2.327 1.959 2.428 2.107 L 11.435 14.621 C 11.653 14.94 12.585 15.444 12.753 15.097 C 12.83 14.936 12.861 14.139 12.76 13.991 L 3.759 1.574 Z"></path>
        <path d="M 11.252 7.343 C 11.255 3.461 8.607 2.927 6.217 4.937 C 5.699 5.373 5.665 7.096 5.396 7.717 C 2.196 7.085 1.395 9.229 3.339 10.727 C 3.76 11.051 4.093 11.12 4.597 11.296 L 6.15 11.461 L 5.887 13.128 L 4.328 13.128 C 1.179 13.149 -1.004 9.56 0.551 6.823 C 1.249 5.597 2.974 5.145 4.149 5.552 C 3.902 1.443 11.353 -0.008 12.878 4.195 C 13.108 4.829 13.047 4.975 13.127 6.098 C 17.038 5.726 16.673 11.28 14.246 12.67 C 13.954 12.835 12.717 12.905 12.394 12.983 L 12.061 12.541 L 10.994 11.058 L 12.96 11.052 C 14.223 10.276 14.876 7.942 11.478 7.709 C 11.461 7.708 11.266 7.35 11.252 7.343 Z"></path>
      </svg>
    ),
    alt: "Cloud Auth Failed",
  },
  [IconType.SEARCH_FUZZY]: {
    faContent: (
      <svg
        className="pp-svg-icon pp-svg-icon-dense"
        viewBox="0 0 40 40"
        fill="none"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M5 20 C 5 12, 20 12, 20 20 C 20 28, 35 28, 35 20" />
      </svg>
    ),
    alt: "Fuzzy Search",
  },
  [IconType.SEARCH_CASE]: {
    faContent: (
      <svg className="pp-svg-icon pp-svg-icon-dense" viewBox="0 0 40 40" fill="currentColor">
        <text x="5" y="26" fontSize="18" fontWeight="700" fontFamily="system-ui, sans-serif" fill="currentColor">
          Aa
        </text>
      </svg>
    ),
    alt: "Case Sensitive",
  },
  [IconType.SEARCH_WHOLE_WORD]: {
    faContent: (
      <svg
        className="pp-svg-icon pp-svg-icon-dense"
        viewBox="0 0 40 40"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <text x="13" y="18" fontSize="12" fontWeight="700" fontFamily="system-ui, sans-serif" fill="currentColor" stroke="none">
          ab
        </text>
        {/* Grouping bracket with visible vertical end caps */}
        <path d="M11 22 V28 H29 V22" strokeWidth="2.4" />
      </svg>
    ),
    alt: "Whole Words",
  },
  [IconType.CHECKBOX_CHECKED]: {
    faIcon: "fa fa-check-square-o",
    alt: "Checked",
  },
  [IconType.CHECKBOX_EMPTY]: {
    faIcon: "fa fa-square-o",
    alt: "Unchecked",
  },
  [IconType.EYE]: {
    faIcon: "fa fa-eye",
    imagePath: "assets/eye.png",
    alt: "Show all including ignored",
  },
};

export class IconService {
  /**
   * Get icon content based on the icon type and settings
   * @param iconType The type of icon to render
   * @param useFontAwesome Whether to use Font Awesome icons (true) or PNG images (false)
   * @returns JSX element containing the appropriate icon
   */
  static getIcon(iconType: IconType, useFontAwesome: boolean): React.ReactNode {
    const config = iconMap[iconType];

    if (!config) {
      console.warn("General", `Icon config not found for type: ${iconType}`);
      return null;
    }

    if (useFontAwesome || !config.imagePath) {
      if (config.faContent) {
        return config.faContent;
      }
      if (config.faIcon) {
        return <i className={config.faIcon}></i>;
      }
      return null;
    }

    // Return PNG image with proper base path
    const className = iconType === IconType.TITLE ? "button-icon title-button-icon" : "button-icon";
    return <img src={getAssetPath(config.imagePath)} alt={config.alt} className={className} />;
  }
}

// React component that uses settings internally
export const Icon: React.FC<{ type: IconType }> = ({ type }) => {
  const { settings } = useSettings();
  const useFontAwesome = settings?.useFontAwesomeIcons ?? false;
  return IconService.getIcon(type, useFontAwesome);
};
