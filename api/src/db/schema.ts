import {sql} from 'drizzle-orm';
import {
  pgTable,
  text,
  integer,
  bigint,
  jsonb,
  primaryKey,
  unique,
  uniqueIndex,
  index,
  check,
} from 'drizzle-orm/pg-core';

/**
 * ThinkerCare Terrain schema, ported from the D1 SQLite migrations
 * (0002_terrain, 0003_restore_owner_access, 0004_terrain_workflow,
 * 0005_service_primes_terrain) to Postgres via Drizzle pg-core.
 *
 * Type rules (design §9.2):
 *  - boolean-ish 0/1 flags (active, force_change, no_sales, consent, clinical,
 *    is_bulk, damaged/expiring counters) stay `integer` to preserve app semantics.
 *  - money (price_hint, total, unit_price, bonus_amount) stays `integer` centimes.
 *  - JSON blobs (tf_missions.brands, tf_tickets.lines, tf_audit.detail) -> `jsonb`.
 *  - timestamps / dates stay `text` (ISO / YYYY-MM-DD) — lexicographic == chronological.
 *  - tf_sessions.expires / tf_throttle.expires -> `bigint` (epoch-ms).
 *  - tf_guards is DROPPED (replaced by SERIALIZABLE transactions + version guard).
 */

export const tfUsers = pgTable('tf_users', {
  id: text('id').primaryKey(),
  username: text('username').notNull().unique(),
  label: text('label').notNull(),
  role: text('role').notNull(),
  active: integer('active').notNull().default(1),
  salt: text('salt').notNull(),
  passwordHash: text('password_hash').notNull(),
  forceChange: integer('force_change').notNull().default(1),
  createdAt: text('created_at').notNull(),
}, (t) => ({
  roleCheck: check('tf_users_role', sql`${t.role} IN ('admin','manager','field','doctor')`),
}));

export const tfSessions = pgTable('tf_sessions', {
  tokenHash: text('token_hash').primaryKey(),
  userId: text('user_id').notNull().references(() => tfUsers.id),
  expires: bigint('expires', {mode: 'number'}).notNull(),
});

export const tfThrottle = pgTable('tf_throttle', {
  bucket: text('bucket').primaryKey(),
  count: integer('count').notNull(),
  expires: bigint('expires', {mode: 'number'}).notNull(),
});

export const tfStores = pgTable('tf_stores', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  kind: text('kind').notNull(),
  city: text('city').notNull(),
  address: text('address').notNull(),
  contact: text('contact').notNull().default(''),
  notes: text('notes').notNull().default(''),
  active: integer('active').notNull().default(1),
});

export const tfDevices = pgTable('tf_devices', {
  id: text('id').primaryKey(),
  name: text('name').notNull().unique(),
  location: text('location').notNull().default(''),
  active: integer('active').notNull().default(1),
});

export const tfProducts = pgTable('tf_products', {
  id: text('id').primaryKey(),
  brand: text('brand').notNull(),
  sku: text('sku').notNull(),
  name: text('name').notNull(),
  unit: text('unit').notNull().default('pièce'),
  priceHint: integer('price_hint').notNull().default(0),
  active: integer('active').notNull().default(1),
  imageUrl: text('image_url').notNull().default(''),
  sourceUrl: text('source_url').notNull().default(''),
  sourceId: text('source_id').notNull().default(''),
  isBulk: integer('is_bulk').notNull().default(0),
  catalogAt: text('catalog_at').notNull().default(''),
}, (t) => ({
  brandCheck: check('tf_products_brand', sql`${t.brand} IN ('TOUCHE','BELNCO','NOOM')`),
  priceCheck: check('tf_products_price', sql`${t.priceHint} >= 0`),
  brandSku: unique('tf_products_brand_sku').on(t.brand, t.sku),
}));

export const tfMissions = pgTable('tf_missions', {
  id: text('id').primaryKey(),
  storeId: text('store_id').notNull().references(() => tfStores.id),
  fieldId: text('field_id').notNull().references(() => tfUsers.id),
  day: text('day').notNull(),
  startAt: text('start_at').notNull(),
  endAt: text('end_at').notNull(),
  brands: jsonb('brands').notNull(),
  deviceId: text('device_id').references(() => tfDevices.id),
  deviceLocation: text('device_location').notNull().default(''),
  instructions: text('instructions').notNull().default(''),
  status: text('status').notNull().default('planned'),
  actualStart: text('actual_start'),
  actualEnd: text('actual_end'),
  cancelReason: text('cancel_reason').notNull().default(''),
  reportStatus: text('report_status').notNull().default('draft'),
  reportNotes: text('report_notes').notNull().default(''),
  reviewNote: text('review_note').notNull().default(''),
  noSales: integer('no_sales').notNull().default(0),
  version: integer('version').notNull().default(1),
  createdBy: text('created_by').notNull(),
  updatedAt: text('updated_at').notNull(),
  lateGraceMinutes: integer('late_grace_minutes').notNull().default(15),
  startPhotoId: text('start_photo_id'),
  endPhotoId: text('end_photo_id'),
}, (t) => ({
  statusCheck: check('tf_missions_status', sql`${t.status} IN ('planned','ongoing','completed','cancelled')`),
  reportStatusCheck: check('tf_missions_report_status', sql`${t.reportStatus} IN ('draft','submitted','approved','changes')`),
  timeCheck: check('tf_missions_time', sql`${t.startAt} < ${t.endAt}`),
  dayIdx: index('tf_mission_day').on(t.day, t.fieldId),
  oneOngoing: uniqueIndex('tf_one_ongoing').on(t.fieldId).where(sql`status = 'ongoing'`),
}));

export const tfCounts = pgTable('tf_counts', {
  missionId: text('mission_id').notNull().references(() => tfMissions.id),
  productId: text('product_id').notNull().references(() => tfProducts.id),
  opening: integer('opening').notNull(),
  received: integer('received').notNull().default(0),
  otherOut: integer('other_out').notNull().default(0),
  closing: integer('closing'),
  damaged: integer('damaged').notNull().default(0),
  expiring: integer('expiring').notNull().default(0),
  expiry: text('expiry').notNull().default(''),
  note: text('note').notNull().default(''),
  updatedBy: text('updated_by').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (t) => ({
  pk: primaryKey({columns: [t.missionId, t.productId]}),
  openingCheck: check('tf_counts_opening', sql`${t.opening} >= 0`),
  receivedCheck: check('tf_counts_received', sql`${t.received} >= 0`),
  otherOutCheck: check('tf_counts_other_out', sql`${t.otherOut} >= 0`),
  closingCheck: check('tf_counts_closing', sql`${t.closing} IS NULL OR ${t.closing} >= 0`),
  damagedCheck: check('tf_counts_damaged', sql`${t.damaged} >= 0`),
  expiringCheck: check('tf_counts_expiring', sql`${t.expiring} >= 0`),
}));

export const tfTickets = pgTable('tf_tickets', {
  id: text('id').primaryKey(),
  missionId: text('mission_id').notNull().references(() => tfMissions.id),
  userId: text('user_id').notNull(),
  createdAt: text('created_at').notNull(),
  lines: jsonb('lines').notNull(),
  total: integer('total').notNull(),
  status: text('status').notNull().default('valid'),
  voidReason: text('void_reason').notNull().default(''),
  bonusAmount: integer('bonus_amount').notNull().default(5000),
}, (t) => ({
  totalCheck: check('tf_tickets_total', sql`${t.total} >= 0`),
  statusCheck: check('tf_tickets_status', sql`${t.status} IN ('valid','void')`),
  bonusCheck: check('tf_tickets_bonus', sql`${t.bonusAmount} >= 0`),
  missionIdx: index('tf_tickets_mission').on(t.missionId, t.createdAt),
}));

export const tfPhotos = pgTable('tf_photos', {
  id: text('id').primaryKey(),
  missionId: text('mission_id').notNull().references(() => tfMissions.id),
  userId: text('user_id').notNull(),
  createdAt: text('created_at').notNull(),
  caption: text('caption').notNull().default(''),
  mime: text('mime').notNull(),
  size: integer('size').notNull(),
  objectKey: text('object_key').notNull().unique(),
  purpose: text('purpose').notNull().default('report'),
});

// Legacy complaint archive — kept (migrated into tf_cases by 0005, retained read-only).
export const tfComplaints = pgTable('tf_complaints', {
  id: text('id').primaryKey(),
  missionId: text('mission_id').notNull().references(() => tfMissions.id),
  authorId: text('author_id').notNull(),
  productId: text('product_id').references(() => tfProducts.id),
  category: text('category').notNull(),
  lot: text('lot').notNull().default(''),
  code: text('code').notNull().default(''),
  status: text('status').notNull().default('new'),
  priority: text('priority').notNull().default('normal'),
  doctorId: text('doctor_id').references(() => tfUsers.id),
  description: text('description').notNull(),
  privateNote: text('private_note').notNull().default(''),
  publicNote: text('public_note').notNull().default(''),
  consent: integer('consent').notNull().default(0),
  version: integer('version').notNull().default(1),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (t) => ({
  categoryCheck: check('tf_complaints_category', sql`${t.category} IN ('quality','commercial','tolerance')`),
  timeIdx: index('tf_complaints_time').on(t.updatedAt),
}));

export const tfAudit = pgTable('tf_audit', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  at: text('at').notNull(),
  action: text('action').notNull(),
  target: text('target').notNull(),
  detail: jsonb('detail').notNull().default({}),
});

export const tfOps = pgTable('tf_ops', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  action: text('action').notNull(),
  target: text('target').notNull(),
  at: text('at').notNull(),
});

export const tfStorePrices = pgTable('tf_store_prices', {
  storeId: text('store_id').notNull().references(() => tfStores.id),
  productId: text('product_id').notNull().references(() => tfProducts.id),
  unitPrice: integer('unit_price').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (t) => ({
  pk: primaryKey({columns: [t.storeId, t.productId]}),
  priceCheck: check('tf_store_prices_price', sql`${t.unitPrice} > 0`),
}));

export const tfAlertAck = pgTable('tf_alert_ack', {
  userId: text('user_id').notNull().references(() => tfUsers.id),
  missionId: text('mission_id').notNull().references(() => tfMissions.id),
  kind: text('kind').notNull(),
  ackAt: text('ack_at').notNull(),
}, (t) => ({
  pk: primaryKey({columns: [t.userId, t.missionId, t.kind]}),
  kindCheck: check('tf_alert_ack_kind', sql`${t.kind} IN ('missing_start','late_start')`),
}));

export const tfCases = pgTable('tf_cases', {
  id: text('id').primaryKey(),
  missionId: text('mission_id').references(() => tfMissions.id),
  storeId: text('store_id').references(() => tfStores.id),
  storeLabel: text('store_label').notNull().default(''),
  authorId: text('author_id').notNull().references(() => tfUsers.id),
  productId: text('product_id').references(() => tfProducts.id),
  kind: text('kind').notNull(),
  reason: text('reason').notNull(),
  category: text('category').notNull(),
  channel: text('channel').notNull().default('onsite'),
  lot: text('lot').notNull().default(''),
  code: text('code').notNull().default(''),
  status: text('status').notNull().default('new'),
  priority: text('priority').notNull().default('normal'),
  doctorId: text('doctor_id').references(() => tfUsers.id),
  assigneeId: text('assignee_id').references(() => tfUsers.id),
  dueDay: text('due_day').notNull().default(''),
  description: text('description').notNull(),
  privateNote: text('private_note').notNull().default(''),
  publicNote: text('public_note').notNull().default(''),
  consent: integer('consent').notNull().default(0),
  version: integer('version').notNull().default(1),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (t) => ({
  kindCheck: check('tf_cases_kind', sql`${t.kind} IN ('complaint','request')`),
  categoryCheck: check('tf_cases_category', sql`${t.category} IN ('quality','commercial','tolerance')`),
  statusCheck: check('tf_cases_status', sql`${t.status} IN ('new','assigned','ongoing','waiting','resolved','closed')`),
  priorityCheck: check('tf_cases_priority', sql`${t.priority} IN ('normal','priority')`),
  createdIdx: index('tf_cases_created').on(t.createdAt),
  authorIdx: index('tf_cases_author').on(t.authorId, t.createdAt),
}));

export const tfCaseEvents = pgTable('tf_case_events', {
  id: text('id').primaryKey(),
  caseId: text('case_id').notNull().references(() => tfCases.id),
  userId: text('user_id').notNull().references(() => tfUsers.id),
  at: text('at').notNull(),
  status: text('status').notNull(),
  note: text('note').notNull().default(''),
  clinical: integer('clinical').notNull().default(0),
});

export const tfFieldNotes = pgTable('tf_field_notes', {
  id: text('id').primaryKey(),
  authorId: text('author_id').notNull().references(() => tfUsers.id),
  missionId: text('mission_id').references(() => tfMissions.id),
  storeId: text('store_id').references(() => tfStores.id),
  storeLabel: text('store_label').notNull().default(''),
  category: text('category').notNull(),
  productId: text('product_id').references(() => tfProducts.id),
  brand: text('brand').notNull().default(''),
  competitor: text('competitor').notNull().default(''),
  sentiment: text('sentiment').notNull().default('neutral'),
  description: text('description').notNull(),
  status: text('status').notNull().default('new'),
  managerNote: text('manager_note').notNull().default(''),
  version: integer('version').notNull().default(1),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (t) => ({
  categoryCheck: check('tf_field_notes_category', sql`${t.category} IN ('shelf','competitor','feedback','availability','opportunity','other')`),
  sentimentCheck: check('tf_field_notes_sentiment', sql`${t.sentiment} IN ('positive','neutral','negative')`),
  statusCheck: check('tf_field_notes_status', sql`${t.status} IN ('new','seen','actioned')`),
  dateIdx: index('tf_field_notes_date').on(t.createdAt),
}));

export const tfFieldPhotos = pgTable('tf_field_photos', {
  id: text('id').primaryKey(),
  noteId: text('note_id').notNull().references(() => tfFieldNotes.id),
  userId: text('user_id').notNull().references(() => tfUsers.id),
  objectKey: text('object_key').notNull().unique(),
  mime: text('mime').notNull(),
  size: integer('size').notNull(),
  createdAt: text('created_at').notNull(),
});
