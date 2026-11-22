/**
 * PostBro Social onboarding foundation.
 *
 * Deliberately not wired to HTTP, production auth, Postiz or persistent storage.
 * Callers MUST supply the organization ID from verified authentication.
 * The in-memory store is for isolated development and tests only.
 *
 * Private Persona Engine source must not be copied into this public repository.
 */
export type Plan = 'STARTER' | 'GROWTH';
export type PersonaSource = 'EXTERNAL_ENGINE' | 'MOCK_PREVIEW';
export type PersonaStatus = 'DRAFT' | 'APPROVED';
export type ClientStatus = 'ONBOARDING' | 'PERSONA_REVIEW' | 'READY';

export interface BrandIntake {
  businessName: string;
  niche: string;
  audience: string;
  language: string;
  tone: string;
  restrictions: string;
}

export interface PersonaProposal {
  summary: string;
  writingStyle: string;
  contentPillars: string;
}

export interface PersonaReview {
  revision: number;
  source: PersonaSource;
  status: PersonaStatus;
  approvedAt: string | null;
  proposal: PersonaProposal;
}

export interface SocialClient {
  id: string;
  organizationId: string;
  plan: Plan;
  status: ClientStatus;
  intake: BrandIntake | null;
  analyzePreviousPosts: boolean;
  previousPostsFetched: false; // Historical import is not implemented yet.
  persona: PersonaReview | null;
}

export interface PersonaEnginePort {
  proposePersona(input: BrandIntake, organizationId: string): Promise<PersonaProposal>;
}

export class OnboardingError extends Error {}

function text(value: unknown, field: string, optional = false): string {
  if (typeof value !== 'string' || (!optional && !value.trim()) || value.length > 1000) {
    throw new OnboardingError(`Invalid ${field}`);
  }
  return value.trim();
}

function requireId(value: unknown, field: string): string {
  const id = text(value, field);
  if (id.includes('::')) {
    throw new OnboardingError(`Invalid ${field}`);
  }
  return id;
}

function normalizeIntake(value: BrandIntake): BrandIntake {
  if (!value || typeof value !== 'object') throw new OnboardingError('Invalid intake');
  return {
    businessName: text(value.businessName, 'businessName'),
    niche: text(value.niche, 'niche'),
    audience: text(value.audience, 'audience'),
    language: text(value.language, 'language'),
    tone: text(value.tone, 'tone'),
    restrictions: text(value.restrictions, 'restrictions', true)
  };
}

function normalizeProposal(value: PersonaProposal): PersonaProposal {
  if (!value || typeof value !== 'object') throw new OnboardingError('Invalid persona');
  return {
    summary: text(value.summary, 'summary'),
    writingStyle: text(value.writingStyle, 'writingStyle'),
    contentPillars: text(value.contentPillars, 'contentPillars')
  };
}

/**
 * Service-layer prototype. NOT a database or authentication boundary.
 * Enforce org ownership here AND with database RLS in the real application.
 */
export class SocialOnboarding {
  static readonly MAX_CLIENTS = 5;
  private readonly clients = new Map<string, SocialClient>();

  private key(organizationId: string, clientId: string): string {
    return `${requireId(organizationId, 'organizationId')}::${requireId(clientId, 'clientId')}`;
  }

  private find(organizationId: string, clientId: string): SocialClient {
    const client = this.clients.get(this.key(organizationId, clientId));
    if (!client) throw new OnboardingError('Client not found');
    return client;
  }

  createClient(organizationId: string, clientId: string, plan: Plan): SocialClient {
    const key = this.key(organizationId, clientId);
    if (plan !== 'STARTER' && plan !== 'GROWTH') {
      throw new OnboardingError('Invalid plan');
    }
    if (this.clients.has(key)) throw new OnboardingError('Client already exists');
    if (this.clients.size >= SocialOnboarding.MAX_CLIENTS) {
      throw new OnboardingError('Five-client pilot limit reached');
    }
    const client: SocialClient = {
      id: clientId,
      organizationId,
      plan,
      status: 'ONBOARDING',
      intake: null,
      analyzePreviousPosts: false,
      previousPostsFetched: false,
      persona: null
    };
    this.clients.set(key, client);
    return structuredClone(client);
  }

  getClient(organizationId: string, clientId: string): SocialClient {
    return structuredClone(this.find(organizationId, clientId));
  }

  listClients(organizationId: string): SocialClient[] {
    const org = requireId(organizationId, 'organizationId');
    return [...this.clients.values()]
      .filter((client) => client.organizationId === org)
      .map((client) => structuredClone(client));
  }

  saveIntake(organizationId: string, clientId: string, value: BrandIntake): SocialClient {
    const intake = normalizeIntake(value); // Validate before any mutation.
    const client = this.find(organizationId, clientId);
    if (JSON.stringify(client.intake) !== JSON.stringify(intake)) {
      client.intake = intake;
      client.persona = null; // Old approval must never survive a brand change.
      client.status = 'ONBOARDING';
    }
    return structuredClone(client);
  }

  setHistoryConsent(organizationId: string, clientId: string, consent: boolean): SocialClient {
    if (typeof consent !== 'boolean') throw new OnboardingError('Consent must be a boolean');
    const client = this.find(organizationId, clientId);
    if (client.analyzePreviousPosts !== consent) {
      client.analyzePreviousPosts = consent;
      client.persona = null;
      client.status = 'ONBOARDING';
    }
    // No reading or background fetching is triggered by this MVP method.
    return structuredClone(client);
  }

  draftPersona(
    organizationId: string,
    clientId: string,
    proposal: PersonaProposal,
    source: PersonaSource
  ): PersonaReview {
    const cleanProposal = normalizeProposal(proposal);
    if (source !== 'EXTERNAL_ENGINE' && source !== 'MOCK_PREVIEW') {
      throw new OnboardingError('Invalid persona source');
    }
    const client = this.find(organizationId, clientId);
    if (!client.intake) throw new OnboardingError('Brand intake required');
    const revision = (client.persona?.revision ?? 0) + 1;
    client.persona = {
      revision,
      source,
      status: 'DRAFT',
      approvedAt: null,
      proposal: cleanProposal
    };
    client.status = 'PERSONA_REVIEW';
    return structuredClone(client.persona);
  }

  editPersona(
    organizationId: string,
    clientId: string,
    expectedRevision: number,
    proposal: PersonaProposal
  ): PersonaReview {
    const cleanProposal = normalizeProposal(proposal);
    const client = this.find(organizationId, clientId);
    if (!client.persona || client.persona.revision !== expectedRevision) {
      throw new OnboardingError('Stale persona revision');
    }
    client.persona = {
      ...client.persona,
      revision: expectedRevision + 1,
      status: 'DRAFT',
      approvedAt: null,
      proposal: cleanProposal
    };
    client.status = 'PERSONA_REVIEW';
    return structuredClone(client.persona);
  }

  approvePersona(organizationId: string, clientId: string, expectedRevision: number): PersonaReview {
    const client = this.find(organizationId, clientId);
    if (!client.persona || client.persona.revision !== expectedRevision) {
      throw new OnboardingError('Stale persona revision');
    }
    if (client.persona.status !== 'DRAFT') throw new OnboardingError('Already approved');
    client.persona.status = 'APPROVED';
    client.persona.approvedAt = new Date().toISOString();
    client.status = 'READY';
    return structuredClone(client.persona);
  }

  getActivePersona(organizationId: string, clientId: string): PersonaReview {
    const client = this.find(organizationId, clientId);
    if (!client.persona || client.persona.status !== 'APPROVED') {
      throw new OnboardingError('Persona not approved');
    }
    if (client.persona.source !== 'EXTERNAL_ENGINE') {
      throw new OnboardingError('Mock persona is preview-only');
    }
    return structuredClone(client.persona);
  }
}
