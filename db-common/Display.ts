export enum DisplayState {
  Normal,
  Black,
  Clear,
}

export interface DisplaySettings {
  state: DisplayState;
  text: string;
  backgroundImage: string | null;
  backgroundColor: string;
  textColor: string;
  textBorderColor: string;
  textBorderWidth: number;
  textShadowOffset: number;
  fontFamily: string;
  songId: string | null;
  section: number;
  item: number;
}
