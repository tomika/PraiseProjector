/**
 * Third-party licence attribution contract, shared by the browser client, the Electron
 * main process and the renderer's About dialog.
 *
 * The section shape was previously re-declared in each of those three modules, differing
 * only in which `id`/`titleKey` literals it allowed. `LicenseSectionOf` is parameterized on
 * exactly those two, so every module keeps its own narrow `LicenseSection` literal typing
 * while there is a single definition of the structure.
 */

export type ThirdPartyEntry = {
  name: string;
  url: string;
  licence: string;
  licenceUrl: string;
};

export type LicenseSectionOf<Id extends string, TitleKey extends string> = {
  id: Id;
  titleKey: TitleKey;
  title: string;
  entries: ThirdPartyEntry[];
};
