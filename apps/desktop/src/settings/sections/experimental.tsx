import { Glyph } from '@pi-desktop/ui';
import { ExperimentalPanel } from '../panels/ExperimentalPanel';
import type { SettingsSectionDef } from './types';

export const experimentalSection: SettingsSectionDef = {
  id: 'experimental',
  label: 'Experimental',
  title: 'Experimental',
  // The memory guard and the alternative inference engines — both experimental,
  // and marked the way everything experimental is: the flask.
  icon: <Glyph name="experimental" />,
  render: () => <ExperimentalPanel />,
};

/**
 * `engines` stays addressable (the composer's engine chip opens it) and lands on
 * the Experimental page, where the engines now live — with Experimental lit in
 * the nav.
 */
export const enginesSection: SettingsSectionDef = {
  id: 'engines',
  label: 'Engines',
  title: 'Engines',
  icon: <Glyph name="experimental" />,
  hidden: true,
  navId: 'experimental',
  render: () => <ExperimentalPanel />,
};

/**
 * `models` is a VIEW now (Model management), and App routes the id there
 * rather than opening this panel; the id survives because the composer's model
 * chip and the sidebar both address it. Should Settings ever be asked for it
 * directly, it shows the Experimental page, as it always has.
 */
export const modelsSection: SettingsSectionDef = {
  id: 'models',
  label: 'Models',
  title: 'Models',
  icon: <Glyph name="experimental" />,
  hidden: true,
  render: () => <ExperimentalPanel />,
};
