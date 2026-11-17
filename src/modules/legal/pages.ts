/**
 * Public legal pages for the PostBro Meta App (privacy policy, terms of
 * service, data deletion instructions). These are static, dependency-free
 * HTML documents served without authentication. They exist to satisfy Meta
 * App Review requirements and to give connected users honest information.
 *
 * Copy constraints (see docs/tasks/PB-LEGAL-001-public-legal-pages.md):
 * - Operator: "PostBro", privately operated and controlled by an individual.
 *   No owner legal name, home address or personal contact details beyond the
 *   public support email postbro33@gmail.com.
 * - Describe ONLY what the current codebase does (Threads OAuth, read client,
 *   inbound reply inbox persistence). Do not claim Facebook/Instagram
 *   engagement, AI automated replies, automated deletion or retention jobs.
 * - Postiz is a separate self-hosted service under the same operator; its
 *   internal retention/storage/token-handling practices are UNVERIFIED and
 *   must be described as such.
 */

export const LEGAL_EFFECTIVE_DATE = '17 November 2026';
export const SUPPORT_EMAIL = 'postbro33@gmail.com';
export const DELETION_SUBJECT = 'PostBro Data Deletion Request';

interface PageSection {
  readonly heading: string;
  readonly body: readonly string[];
}

function renderPage(title: string, sections: readonly PageSection[]): string {
  const body = sections
    .map(
      (section) => `    <section>
      <h2>${section.heading}</h2>
${section.body.map((paragraph) => `      <p>${paragraph}</p>`).join('\n')}
    </section>`,
    )
    .join('\n');
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title} &mdash; PostBro</title>
  <style>
    :root { color-scheme: light dark; }
    body { font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
           line-height: 1.6; margin: 0; padding: 1rem; }
    main { max-width: 46rem; margin: 0 auto; }
    h1 { font-size: 1.6rem; } h2 { font-size: 1.2rem; margin-top: 1.8rem; }
    nav ul { list-style: none; padding: 0; display: flex; gap: 1rem; flex-wrap: wrap; }
    footer { margin-top: 2.5rem; font-size: 0.9rem; color: #666; }
  </style>
</head>
<body>
  <main>
    <header>
      <h1>${title}</h1>
      <p><strong>Effective date:</strong> ${LEGAL_EFFECTIVE_DATE}</p>
      <nav aria-label="Legal pages">
        <ul>
          <li><a href="/privacy">Privacy Policy</a></li>
          <li><a href="/terms">Terms of Service</a></li>
          <li><a href="/data-deletion">Data Deletion</a></li>
        </ul>
      </nav>
    </header>
${body}
    <footer>
      <p>PostBro is privately operated and controlled by an individual.
      Contact: <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a>.</p>
    </footer>
  </main>
</body>
</html>
`;
}

export function renderPrivacyPage(): string {
  return renderPage('Privacy Policy', [
    {
      heading: 'Who operates this service',
      body: [
        'PostBro is a privately operated software service, controlled by an individual operator (not a company). It provides tools that connect to authorised social media accounts through official Meta APIs. You can reach the operator at any time via <a href="mailto:postbro33@gmail.com">postbro33@gmail.com</a>.',
        'The service consists of two distinct components under the same operator: <strong>PostBro</strong> (this application, which handles Threads account connection and inbound engagement management) and <strong>Postiz</strong> (a separately self-hosted posting and scheduling tool that connects Facebook Pages, Instagram and Threads profiles).',
      ],
    },
    {
      heading: 'What PostBro currently processes (Threads)',
      body: [
        'As of the effective date above, PostBro&rsquo;s functionality is limited to connecting your Threads account and reading inbound replies to your threads. When you connect an account, PostBro stores:',
        'Your Threads user ID and username; the permissions (scopes) you grant during authorisation; and your access token, stored in encrypted form.',
        'To show you inbound engagement, PostBro reads your own threads from Meta&rsquo;s API while the service runs. Reply text, timestamps and conversation relationships from other users&rsquo; replies to your threads are stored so that your engagement inbox can be reviewed and managed.',
        'PostBro does <em>not</em> currently send automated or AI-generated replies. AI-assisted drafting is a possible future capability and is not live; if it is introduced, this policy will be updated before it is enabled.',
      ],
    },
    {
      heading: 'What Postiz processes (posting and scheduling)',
      body: [
        'Postiz is a separate, self-hosted service operated by the same individual. It handles authorised Facebook Page, Instagram and Threads profile connections, and post scheduling and publishing. To do this, Postiz processes the content you submit for posting and the identifiers and account details of your connected profiles needed to manage scheduled and published posts.',
        'The specific retention, storage and token-handling practices of this separate Postiz installation have not been independently verified for the purposes of this policy, and this policy makes no claims about them. Questions about data held in Postiz, and requests to access or delete it, can be directed to <a href="mailto:postbro33@gmail.com">postbro33@gmail.com</a>.',
      ],
    },
    {
      heading: 'Service providers and infrastructure',
      body: [
        'PostBro stores its data in a hosted PostgreSQL database provided by Supabase, runs on rented cloud virtual-server infrastructure, and is served to the public internet through the Cloudflare proxy. It communicates with Meta&rsquo;s official APIs to provide Threads functionality. Postiz is a distinct self-hosted service under the same operator. PostBro does not currently send your data to any AI/LLM provider or messaging platform as part of the live service.',
      ],
    },
    {
      heading: 'Security',
      body: [
        'PostBro access tokens are stored encrypted at rest, and access to the service and its data is restricted to the operator. Reasonable care is taken to protect stored information, but no method of storage or transmission can be guaranteed to be absolutely secure, and this policy does not promise absolute security.',
      ],
    },
    {
      heading: 'No sale of data; no advertising use',
      body: [
        'Personal data processed through this service is not sold, and is not used by this service for targeted advertising.',
      ],
    },
    {
      heading: 'Lawful basis and your choices',
      body: [
        'Accounts are connected voluntarily by their owners or authorised users, who grant permissions through Meta&rsquo;s official authorisation flow and may revoke them at any time (see the <a href="/data-deletion">Data Deletion</a> page). Data is processed only to provide the requested service features.',
        'You may request access to, correction of, or deletion of your data by emailing <a href="mailto:postbro33@gmail.com">postbro33@gmail.com</a>. Deletion instructions are described on the <a href="/data-deletion">Data Deletion</a> page.',
      ],
    },
    {
      heading: 'Data retention',
      body: [
        'Data is retained for as long as it is needed to provide the service, and until you request deletion. A formal retention schedule has not yet been finalised; this service does not currently operate an automatic data-purge job, and this policy does not pretend otherwise. Once a retention schedule is defined, this policy will be updated. Meta (Facebook/Instagram/Threads) may retain its own data independently under its own policies; this service has no control over Meta&rsquo;s retention.',
      ],
    },
    {
      heading: 'Changes to this policy',
      body: [
        'If this policy changes, the updated version will be published at this URL with a revised effective date. Material changes will be made before, not after, any related change in behaviour. Questions: <a href="mailto:postbro33@gmail.com">postbro33@gmail.com</a>.',
      ],
    },
  ]);
}

export function renderTermsPage(): string {
  return renderPage('Terms of Service', [
    {
      heading: 'Authorised use only',
      body: [
        'PostBro is a privately operated service made available to the operator and to authorised personal, company and friends&rsquo; accounts by invitation. You may only connect accounts that you own or are explicitly authorised to manage.',
      ],
    },
    {
      heading: 'Meta platform terms',
      body: [
        'This service uses Meta&rsquo;s official APIs. Your use of Facebook, Instagram and Threads through this service is additionally governed by Meta&rsquo;s own terms, policies and platform rules, which you are responsible for complying with.',
      ],
    },
    {
      heading: 'Acceptable use',
      body: [
        'You may publish content and manage engagement only through the authorised features of the service. You are responsible for the content you create, schedule, publish or send through connected accounts. You must not use the service for unsolicited bulk messaging, spam, harassment, abuse, or any activity that violates applicable law or platform rules.',
        'You may revoke the service&rsquo;s access to your Meta accounts at any time through your Meta account settings; see the <a href="/data-deletion">Data Deletion</a> page for instructions.',
      ],
    },
    {
      heading: 'Service availability and changes',
      body: [
        'Features of the service may change, be suspended or be withdrawn at any time, including where required by changes in Meta&rsquo;s APIs or policies. The service is provided as-is and no particular level of uptime or availability is guaranteed.',
      ],
    },
    {
      heading: 'Liability',
      body: [
        'The operator&rsquo;s liability is limited to the extent permitted by applicable law. Nothing in these terms excludes or limits any liability that cannot legally be excluded or limited.',
      ],
    },
    {
      heading: 'Contact',
      body: [
        'Support and questions about these terms: <a href="mailto:postbro33@gmail.com">postbro33@gmail.com</a>. See also the <a href="/privacy">Privacy Policy</a> and <a href="/data-deletion">Data Deletion</a> instructions. Effective date: 17 November 2026.',
      ],
    },
  ]);
}

export function renderDataDeletionPage(): string {
  return renderPage('Data Deletion Instructions', [
    {
      heading: 'How to request deletion',
      body: [
        'Email <a href="mailto:postbro33@gmail.com">postbro33@gmail.com</a> with the subject line <strong>&ldquo;PostBro Data Deletion Request&rdquo;</strong>. In your message, identify the connected social media handle and platform (for example, your Threads username) and suggest a safe way for the operator to verify that the account is yours (for example, confirming from the connected account&rsquo;s email address).',
        '<strong>Never send passwords, Meta App Secrets, or access tokens.</strong> The operator will never ask you for them.',
      ],
    },
    {
      heading: 'What happens next',
      body: [
        'Deletion requests are handled manually by the operator. The operator will verify account ownership using the information you provide, disconnect the account within the service where possible, remove account-specific data stored in PostBro, assess any linked data held in the separately self-hosted Postiz service, and then follow up with a written confirmation by email.',
        'Some records may need to be retained where necessary for legal or security reasons, and data contained in backups may persist until those backups cycle out. There is currently no automated deletion pipeline and no fixed processing-time guarantee; the operator commits to responding without undue delay.',
      ],
    },
    {
      heading: 'Removing the app on the Meta side',
      body: [
        'You can remove this app&rsquo;s access yourself at any time. In your Facebook, Instagram or Threads account settings, look for the section listing apps or websites connected to your account (the exact menu name and location can change over time) and remove the app from that list.',
        'Revoking the app&rsquo;s access stops all future API access to your account, but it does <em>not</em> automatically delete data already stored in PostBro or Postiz. To have stored data removed, please also send a deletion request by email as described above.',
      ],
    },
    {
      heading: 'If your content appears in someone else&rsquo;s connected account',
      body: [
        'If you wrote a reply to a thread owned by a connected account, some of your content (such as reply text and timestamps) may be stored in PostBro as part of that account&rsquo;s engagement inbox. If you would like stored content that refers to your content to be deleted, email <a href="mailto:postbro33@gmail.com">postbro33@gmail.com</a> identifying the relevant content (for example, a link to the thread and the approximate date). To protect other users&rsquo; data, the operator may ask for reasonable verification and will not disclose information about other accounts.',
      ],
    },
    {
      heading: 'Questions',
      body: [
        'See the <a href="/privacy">Privacy Policy</a> and <a href="/terms">Terms of Service</a>. Contact: <a href="mailto:postbro33@gmail.com">postbro33@gmail.com</a>.',
      ],
    },
  ]);
}
