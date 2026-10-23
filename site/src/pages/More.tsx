// The phone tab "More" (STYLE-SPEC Navigation): Vault, Activity and the wallet.
import { Page } from '../components/Shell';
import { Icon } from '../components/ui';
import { COPY } from '../copy';
import { Link } from '../lib/router';

export function More() {
  return (
    <Page className="narrow">
      <ul className="more">
        {[{ to: '/vault', label: COPY.nav.vault }, { to: '/activity', label: COPY.nav.activity }, { to: '/me', label: COPY.me.connect }].map((l) => (
          <li key={l.to}><Link to={l.to} className="more-a">{l.label}<Icon name="chevron" /></Link></li>
        ))}
      </ul>
    </Page>
  );
}
