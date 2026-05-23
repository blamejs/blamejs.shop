-- Product Q&A: PDP-attached question + answer threads, operator-
-- moderated, distinct from the rating-based reviews primitive
-- (0011_reviews.sql).
--
-- Three tables:
--
--   * `product_qa_questions` — one row per customer-submitted question
--     against a product. `customer_id` is the optional authenticated
--     submitter; the email-only branch leaves it NULL and stores
--     `customer_email_hash` (SHA3-512 via the
--     `product-qa-customer-email` namespace) so the raw address never
--     persists. `status` is the moderation FSM:
--       pending  -> approved   (approveQuestion)
--       pending  -> rejected   (rejectQuestion)
--     Rejected rows are reclaimed by `cleanupRejected(days)` after a
--     retention window. `pinned` is a deprecated hold-over column kept
--     for symmetry with answers (questions themselves never float —
--     the answers under them do); operators never write to it.
--     `vote_count` is denormalised — every `voteUpAnswer` insert into
--     `product_qa_votes` bumps the matching `product_qa_answers.vote_count`
--     in the same transaction. Questions don't accept votes in v1.
--
--   * `product_qa_answers` — one row per answer attached to a question.
--     FK CASCADE on `question_id` so deleting a question wipes its
--     thread. `author` is the principal-class enum (operator / customer
--     / system); `is_operator` is the denormalised pin gate (an answer
--     can only be pinned by `pinAnswer` if `is_operator = 1`). Same
--     `status` FSM as questions. `pinned` floats the answer to the
--     top of `topAnswerForQuestion`; only one pinned answer per
--     question is enforced by the partial unique index below.
--     `vote_count` carries the running tally of distinct-session
--     thumbs-up signals from `product_qa_votes`.
--
--   * `product_qa_votes` — one row per (answer_id, session_id_hash)
--     vote-up. `session_id_hash` is the SHA3-512 of the visitor's
--     session id under the `product-qa-vote-session` namespace; the
--     UNIQUE constraint on (answer_id, session_id_hash) makes
--     repeated taps from the same browser tab a no-op. Raw session
--     ids never persist.
--
-- Indexes drive the hot read paths:
--   * (product_id, status, occurred_at)  — questionsForProduct paging
--   * (question_id, status, pinned, vote_count) — topAnswerForQuestion
--   * (answer_id)                         — votes-by-answer drain
--   * (status, occurred_at)               — cleanupRejected sweep

CREATE TABLE IF NOT EXISTS product_qa_questions (
  id                   TEXT    NOT NULL PRIMARY KEY,
  product_id           TEXT    NOT NULL,
  customer_id          TEXT,
  customer_email_hash  TEXT,
  body                 TEXT    NOT NULL,
  status               TEXT    NOT NULL CHECK (status IN ('pending', 'approved', 'rejected')),
  pinned               INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
  vote_count           INTEGER NOT NULL DEFAULT 0 CHECK (vote_count >= 0),
  occurred_at          INTEGER NOT NULL,
  FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_product_qa_questions_product
  ON product_qa_questions(product_id, status, occurred_at);
CREATE INDEX IF NOT EXISTS idx_product_qa_questions_status
  ON product_qa_questions(status, occurred_at);
CREATE INDEX IF NOT EXISTS idx_product_qa_questions_customer
  ON product_qa_questions(customer_id);

CREATE TABLE IF NOT EXISTS product_qa_answers (
  id            TEXT    NOT NULL PRIMARY KEY,
  question_id   TEXT    NOT NULL,
  author        TEXT    NOT NULL CHECK (author IN ('operator', 'customer', 'system')),
  author_id     TEXT,
  body          TEXT    NOT NULL,
  is_operator   INTEGER NOT NULL DEFAULT 0 CHECK (is_operator IN (0, 1)),
  status        TEXT    NOT NULL CHECK (status IN ('pending', 'approved', 'rejected')),
  pinned        INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
  vote_count    INTEGER NOT NULL DEFAULT 0 CHECK (vote_count >= 0),
  occurred_at   INTEGER NOT NULL,
  FOREIGN KEY (question_id) REFERENCES product_qa_questions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_product_qa_answers_question
  ON product_qa_answers(question_id, status, pinned, vote_count);
CREATE INDEX IF NOT EXISTS idx_product_qa_answers_status
  ON product_qa_answers(status, occurred_at);

-- One pinned answer per question. Partial unique index — answers
-- with pinned=0 don't participate so the constraint doesn't trip
-- when every answer starts un-pinned.
CREATE UNIQUE INDEX IF NOT EXISTS idx_product_qa_answers_pinned_uniq
  ON product_qa_answers(question_id) WHERE pinned = 1;

CREATE TABLE IF NOT EXISTS product_qa_votes (
  id               TEXT    NOT NULL PRIMARY KEY,
  answer_id        TEXT    NOT NULL,
  session_id_hash  TEXT    NOT NULL,
  occurred_at      INTEGER NOT NULL,
  FOREIGN KEY (answer_id) REFERENCES product_qa_answers(id) ON DELETE CASCADE,
  UNIQUE (answer_id, session_id_hash)
);

CREATE INDEX IF NOT EXISTS idx_product_qa_votes_answer
  ON product_qa_votes(answer_id);
