import {useEffect, useId, useState, type FormEvent} from 'react';
import {request} from './client';

export function Password({done, required = false}: {done: () => void | Promise<void>; required?: boolean}) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const values = Object.fromEntries(new FormData(form));
    setError('');
    if (values.next !== values.confirm) {
      setError('Les deux nouveaux mots de passe diffèrent.');
      return;
    }
    setBusy(true);
    try {
      await request('', {action: 'password', current: values.current, next: values.next});
      form.reset();
      await done();
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return <section className="panel password-panel">
    <h2>{required ? 'Créez votre mot de passe personnel.' : 'Modifier mon mot de passe'}</h2>
    <p>{required
      ? 'Remplacez le mot de passe temporaire pour accéder à votre espace. Utilisez ensuite votre nouveau mot de passe à chaque connexion.'
      : 'Votre nouveau mot de passe sera enregistré pour vos prochaines connexions.'}</p>
    <form onSubmit={save}>
      <label>Mot de passe actuel<input name="current" type="password" autoComplete="current-password" maxLength={200} required disabled={busy}/></label>
      <label>Nouveau mot de passe<input name="next" type="password" autoComplete="new-password" maxLength={200} required disabled={busy}/></label>
      <label>Confirmer le nouveau mot de passe<input name="confirm" type="password" autoComplete="new-password" maxLength={200} required disabled={busy}/></label>
      <small>Les autres sessions seront déconnectées.</small>
      <small>L’administrateur peut consulter ce mot de passe et le réinitialiser. Choisissez un mot de passe réservé à Terrain.</small>
      {error && <div className="notice error" role="alert">{error}</div>}
      <button className="primary" disabled={busy}>{busy ? 'Enregistrement…' : 'Enregistrer mon mot de passe'}</button>
    </form>
  </section>;
}

export function SavedPassword({userId, available}: {userId: string; available: boolean}) {
  const [confirming, setConfirming] = useState(false);
  const [adminPassword, setAdminPassword] = useState('');
  const [password, setPassword] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (password === null) return;
    const timer = window.setTimeout(() => setPassword(null), 60000);
    const hide = () => { if (document.hidden) setPassword(null); };
    document.addEventListener('visibilitychange', hide);
    return () => { window.clearTimeout(timer); document.removeEventListener('visibilitychange', hide); };
  }, [password]);

  async function reveal() {
    setBusy(true);
    setError('');
    try {
      const result = await request('', {action: 'user-password', id: userId, adminPassword});
      setPassword(result.password);
      if (result.password === null) setError('Ce mot de passe ancien ne peut pas être récupéré. Réinitialisez-le ci-dessous.');
      setConfirming(false);
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setAdminPassword('');
      setBusy(false);
    }
  }

  return <section aria-label="Mot de passe enregistré">
    <h3>Mot de passe enregistré</h3>
    {!available ? <p>Ce mot de passe a été enregistré avant l’activation de la consultation. Il sera visible après le prochain changement par la personne ou une réinitialisation ci-dessous.</p>
      : password !== null ? <>
        <label>Mot de passe actuel de ce compte<input type="text" readOnly value={password} autoComplete="off"/></label>
        <button type="button" className="text" onClick={() => setPassword(null)}>Masquer le mot de passe</button>
        <small>Affichage masqué automatiquement après une minute. Cette consultation est enregistrée dans la traçabilité.</small>
      </> : confirming ? <>
        <label>Votre mot de passe administrateur<input type="password" autoComplete="current-password"
          value={adminPassword} maxLength={200} disabled={busy}
          onChange={event => setAdminPassword(event.target.value)}
          onKeyDown={event => {if (event.key === 'Enter') {event.preventDefault(); if (adminPassword && !busy) void reveal();}}}/></label>
        <div className="section-head">
          <button type="button" className="outline" disabled={busy || !adminPassword} onClick={() => void reveal()}>{busy ? 'Vérification…' : 'Confirmer et afficher'}</button>
          <button type="button" className="text" disabled={busy} onClick={() => {setConfirming(false); setAdminPassword(''); setError('');}}>Annuler</button>
        </div>
      </> : <button type="button" className="outline" onClick={() => {setConfirming(true); setError('');}}>Voir le mot de passe enregistré</button>}
    {error && <div className="notice error" role="alert">{error}</div>}
  </section>;
}

/** Only reveals a new, unsaved temporary password entered by the admin. */
export function AdminPasswordField({existing}: {existing: boolean}) {
  const id = useId();
  const [value, setValue] = useState('');
  const [visible, setVisible] = useState(false);

  function generate() {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const bytes = crypto.getRandomValues(new Uint8Array(24));
    setValue(Array.from(bytes, byte => alphabet[byte % alphabet.length]).join(''));
    setVisible(true);
  }

  return <>
    <label htmlFor={id}>{existing ? 'Réinitialiser le mot de passe' : 'Mot de passe temporaire'}
      <input id={id} name="password" type={visible ? 'text' : 'password'} autoComplete="new-password"
        maxLength={200} required={!existing} value={value}
        onChange={event => setValue(event.target.value)} aria-describedby={id + '-help'}/>
    </label>
    <div className="section-head">
      <button type="button" className="text" onClick={generate}>Générer un mot de passe temporaire</button>
      <button type="button" className="text" aria-controls={id} aria-pressed={visible}
        onClick={() => setVisible(!visible)}>{visible ? 'Masquer' : 'Afficher la saisie'}</button>
    </div>
    <small id={id + '-help'}>
      {existing && 'Laissez ce champ vide pour conserver le mot de passe actuel. '}
      Enregistrez puis transmettez le mot de passe temporaire à la personne. Elle devra le remplacer à sa prochaine connexion.
      {' '}Une réinitialisation ou une désactivation déconnecte ses sessions.
    </small>
  </>;
}
