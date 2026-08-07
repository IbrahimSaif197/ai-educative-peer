from session_store import code_fingerprint, InMemorySessionStore, FirestoreSessionStore, build_session_store


class TestCodeFingerprint:
    def test_same_code_same_fingerprint(self):
        assert code_fingerprint("x = 1\n") == code_fingerprint("x = 1")

    def test_trailing_whitespace_ignored(self):
        assert code_fingerprint("x = 1   \n") == code_fingerprint("x = 1")

    def test_different_code_different_fingerprint(self):
        assert code_fingerprint("x = 1") != code_fingerprint("x = 2")


class TestInMemorySessionStore:
    def test_level_starts_at_1(self):
        store = InMemorySessionStore()
        assert store.next_hint_level("u1", "fp1") == 1

    def test_level_increments(self):
        store = InMemorySessionStore()
        store.next_hint_level("u1", "fp1")
        assert store.next_hint_level("u1", "fp1") == 2

    def test_level_caps_at_3(self):
        store = InMemorySessionStore()
        for _ in range(5):
            level = store.next_hint_level("u1", "fp1")
        assert level == 3

    def test_different_fingerprint_independent(self):
        store = InMemorySessionStore()
        store.next_hint_level("u1", "fp1")
        store.next_hint_level("u1", "fp1")
        assert store.next_hint_level("u1", "fp2") == 1

    def test_different_user_independent(self):
        store = InMemorySessionStore()
        store.next_hint_level("u1", "fp1")
        store.next_hint_level("u1", "fp1")
        assert store.next_hint_level("u2", "fp1") == 1

    def test_begin_session_returns_true_first_time(self):
        store = InMemorySessionStore()
        assert store.begin_session("u1") is True

    def test_begin_session_returns_false_when_active(self):
        store = InMemorySessionStore()
        store.begin_session("u1")
        assert store.begin_session("u1") is False

    def test_reset_clears_levels(self):
        store = InMemorySessionStore()
        store.next_hint_level("u1", "fp1")
        store.next_hint_level("u1", "fp1")
        store.reset("u1")
        assert store.next_hint_level("u1", "fp1") == 1

    def test_reset_clears_session_flag(self):
        store = InMemorySessionStore()
        store.begin_session("u1")
        store.reset("u1")
        assert store.begin_session("u1") is True

    def test_reset_only_affects_target_user(self):
        store = InMemorySessionStore()
        store.next_hint_level("u1", "fp1")
        store.next_hint_level("u2", "fp1")
        store.reset("u1")
        assert store.next_hint_level("u2", "fp1") == 2

    def test_eviction_drops_oldest(self):
        store = InMemorySessionStore(max_entries=2)
        store.next_hint_level("u1", "fp1")  # key A
        store.next_hint_level("u1", "fp2")  # key B
        store.next_hint_level("u1", "fp3")  # key C -> evicts A
        # A was evicted, so it restarts at level 1
        assert store.next_hint_level("u1", "fp1") == 1


# --- Minimal in-memory fake Firestore client ---------------------------------

class _FakeSnap:
    def __init__(self, data):
        self._data = data
        self.exists = data is not None

    def to_dict(self):
        return dict(self._data) if self._data is not None else {}


class _FakeDocRef:
    def __init__(self, col, doc_id):
        self._col = col
        self._id = doc_id
        self.reference = self

    def get(self, **kwargs):
        return _FakeSnap(self._col._docs.get(self._id))

    def set(self, data, merge=False, **kwargs):
        if merge and self._id in self._col._docs:
            self._col._docs[self._id].update(data)
        else:
            self._col._docs[self._id] = dict(data)

    def delete(self):
        self._col._docs.pop(self._id, None)


class _FakeQuery:
    def __init__(self, refs):
        self._refs = refs

    def stream(self, **kwargs):
        return list(self._refs)


class _FakeCollection:
    def __init__(self):
        self._docs = {}  # doc_id -> data dict

    def document(self, doc_id):
        return _FakeDocRef(self, doc_id)

    def where(self, field, op, value):
        refs = [
            _FakeDocRef(self, doc_id)
            for doc_id, data in self._docs.items()
            if op == "==" and data.get(field) == value
        ]
        return _FakeQuery(refs)


class _FakeBatch:
    def __init__(self):
        self._ops = []

    def delete(self, ref):
        self._ops.append(ref)

    def commit(self, **kwargs):
        for ref in self._ops:
            ref.delete()
        self._ops = []


class FakeFirestore:
    def __init__(self):
        self._cols = {}

    def collection(self, name):
        return self._cols.setdefault(name, _FakeCollection())

    def batch(self):
        return _FakeBatch()


# --- FirestoreSessionStore tests ---------------------------------------------

class TestFirestoreSessionStore:
    def _store(self):
        return FirestoreSessionStore(FakeFirestore())

    def test_level_starts_at_1(self):
        store = self._store()
        assert store.next_hint_level("u1", "fp1") == 1

    def test_level_increments_and_persists(self):
        store = self._store()
        store.next_hint_level("u1", "fp1")
        assert store.next_hint_level("u1", "fp1") == 2

    def test_level_caps_at_3(self):
        store = self._store()
        for _ in range(5):
            level = store.next_hint_level("u1", "fp1")
        assert level == 3

    def test_different_fingerprint_independent(self):
        store = self._store()
        store.next_hint_level("u1", "fp1")
        store.next_hint_level("u1", "fp1")
        assert store.next_hint_level("u1", "fp2") == 1

    def test_begin_session_first_time_true(self):
        store = self._store()
        assert store.begin_session("u1") is True

    def test_begin_session_active_false(self):
        store = self._store()
        store.begin_session("u1")
        assert store.begin_session("u1") is False

    def test_reset_clears_levels(self):
        store = self._store()
        store.next_hint_level("u1", "fp1")
        store.next_hint_level("u1", "fp1")
        store.reset("u1")
        assert store.next_hint_level("u1", "fp1") == 1

    def test_reset_clears_session_flag(self):
        store = self._store()
        store.begin_session("u1")
        store.reset("u1")
        assert store.begin_session("u1") is True

    def test_reset_only_affects_target_user(self):
        store = self._store()
        store.next_hint_level("u1", "fp1")
        store.next_hint_level("u2", "fp1")
        store.reset("u1")
        assert store.next_hint_level("u2", "fp1") == 2


class TestBuildSessionStore:
    def test_returns_firestore_when_enabled(self):
        class _FB:
            enabled = True
            client = FakeFirestore()
        store = build_session_store(_FB())
        assert isinstance(store, FirestoreSessionStore)

    def test_returns_in_memory_when_disabled(self):
        class _FB:
            enabled = False
            client = None
        store = build_session_store(_FB())
        assert isinstance(store, InMemorySessionStore)


# --- Firestore timeout / fail-fast behavior ----------------------------------

class TestFirestoreTimeout:
    """The Firestore calls must pass a bounded timeout so a hung backend fails
    fast (and degrades to safe defaults) instead of blocking forever."""

    def test_get_is_called_with_timeout(self):
        captured = {}

        class _SpyRef:
            reference = None

            def get(self, **kwargs):
                captured.update(kwargs)
                return _FakeSnap(None)

            def set(self, data, merge=False, **kwargs):
                pass

        class _SpyCollection:
            def document(self, _doc_id):
                return _SpyRef()

        class _SpyClient:
            def collection(self, _name):
                return _SpyCollection()

        store = FirestoreSessionStore(_SpyClient())
        store.next_hint_level("u1", "fp1")
        assert captured.get("timeout") == FirestoreSessionStore.TIMEOUT

    def test_set_is_called_with_timeout(self):
        captured = {}

        class _SpyRef:
            def get(self, **kwargs):
                return _FakeSnap(None)

            def set(self, data, merge=False, **kwargs):
                captured.update(kwargs)

        class _SpyCollection:
            def document(self, _doc_id):
                return _SpyRef()

        class _SpyClient:
            def collection(self, _name):
                return _SpyCollection()

        store = FirestoreSessionStore(_SpyClient())
        store.next_hint_level("u1", "fp1")
        assert captured.get("timeout") == FirestoreSessionStore.TIMEOUT

    def test_returns_default_when_firestore_times_out(self):
        class _SlowRef:
            def get(self, **kwargs):
                raise TimeoutError("deadline exceeded")

            def set(self, data, merge=False, **kwargs):
                raise TimeoutError("deadline exceeded")

        class _SlowCollection:
            def document(self, _doc_id):
                return _SlowRef()

        class _SlowClient:
            def collection(self, _name):
                return _SlowCollection()

        store = FirestoreSessionStore(_SlowClient())
        # Degrades to safe defaults rather than propagating the timeout.
        assert store.next_hint_level("u1", "fp1") == 1
        assert store.begin_session("u1") is False
        assert store.current_hint_level("u1", "fp1") == 1


class TestResolveLevel:
    def test_escalating_from_nothing_is_level_one(self):
        from session_store import resolve_level
        assert resolve_level(0, escalate=True) == 1

    def test_escalating_advances_by_one(self):
        from session_store import resolve_level
        assert resolve_level(1, escalate=True) == 2

    def test_escalating_stops_at_three(self):
        from session_store import resolve_level
        assert resolve_level(3, escalate=True) == 3

    def test_not_escalating_reuses_the_level(self):
        from session_store import resolve_level
        assert resolve_level(2, escalate=False) == 2

    def test_not_escalating_from_nothing_floors_at_one(self):
        from session_store import resolve_level
        assert resolve_level(0, escalate=False) == 1

    def test_a_corrupt_high_level_is_clamped(self):
        from session_store import resolve_level
        assert resolve_level(99, escalate=False) == 3


class TestPeekAndCommit:
    """Peek must be read-only; only commit spends a level."""

    def _store(self):
        from session_store import InMemorySessionStore
        return InMemorySessionStore()

    def test_peek_does_not_persist_anything(self):
        store = self._store()
        assert store.peek_hint_level("u1", "fp1") == 1
        assert store.peek_hint_level("u1", "fp1") == 1
        assert store.peek_hint_level("u1", "fp1") == 1

    def test_commit_makes_the_next_peek_advance(self):
        store = self._store()
        level = store.peek_hint_level("u1", "fp1")
        store.commit_hint_level("u1", "fp1", level)
        assert store.peek_hint_level("u1", "fp1") == 2

    def test_peek_without_escalating_reuses_the_committed_level(self):
        store = self._store()
        store.commit_hint_level("u1", "fp1", 2)
        assert store.peek_hint_level("u1", "fp1", escalate=False) == 2

    def test_commit_clamps_out_of_range_levels(self):
        store = self._store()
        store.commit_hint_level("u1", "fp1", 99)
        assert store.peek_hint_level("u1", "fp1", escalate=False) == 3
        store.commit_hint_level("u1", "fp2", 0)
        assert store.peek_hint_level("u1", "fp2", escalate=False) == 1

    def test_peek_is_scoped_per_user_and_fingerprint(self):
        store = self._store()
        store.commit_hint_level("u1", "fp1", 3)
        assert store.peek_hint_level("u2", "fp1") == 1
        assert store.peek_hint_level("u1", "fp2") == 1

    def test_commit_respects_the_entry_bound(self):
        from session_store import InMemorySessionStore
        store = InMemorySessionStore(max_entries=5)
        for i in range(50):
            store.commit_hint_level("u1", f"fp{i}", 1)
        assert len(store._levels) == 5

    def test_next_hint_level_is_peek_plus_commit(self):
        store = self._store()
        assert store.next_hint_level("u1", "fp1") == 1
        assert store.peek_hint_level("u1", "fp1", escalate=False) == 1

    def test_reset_clears_committed_levels(self):
        store = self._store()
        store.commit_hint_level("u1", "fp1", 3)
        store.reset("u1")
        assert store.peek_hint_level("u1", "fp1") == 1


class TestFirestorePeekAndCommit:
    def _store_with(self, stored_level):
        from session_store import FirestoreSessionStore

        writes = []

        class _Snap:
            exists = stored_level is not None

            def to_dict(self):
                return {"hint_level": stored_level}

        class _Ref:
            def get(self, **kwargs):
                return _Snap()

            def set(self, data, **kwargs):
                writes.append(data)

        class _Collection:
            def document(self, _doc_id):
                return _Ref()

        class _Client:
            def collection(self, _name):
                return _Collection()

        return FirestoreSessionStore(_Client()), writes

    def test_peek_writes_nothing(self):
        store, writes = self._store_with(1)
        assert store.peek_hint_level("u1", "fp1") == 2
        assert writes == []

    def test_peek_on_a_missing_document_is_level_one(self):
        store, writes = self._store_with(None)
        assert store.peek_hint_level("u1", "fp1") == 1
        assert writes == []

    def test_peek_without_escalating_writes_nothing(self):
        store, writes = self._store_with(None)
        assert store.peek_hint_level("u1", "fp1", escalate=False) == 1
        assert writes == []

    def test_commit_writes_the_level(self):
        store, writes = self._store_with(1)
        store.commit_hint_level("u1", "fp1", 2)
        assert writes[0]["hint_level"] == 2
        assert writes[0]["user_id"] == "u1"
        assert writes[0]["fingerprint"] == "fp1"

    def test_commit_clamps_before_writing(self):
        store, writes = self._store_with(1)
        store.commit_hint_level("u1", "fp1", 99)
        assert writes[0]["hint_level"] == 3

    def test_peek_degrades_to_one_on_error(self):
        from session_store import FirestoreSessionStore

        class _Boom:
            def collection(self, _name):
                raise TimeoutError("deadline exceeded")

        assert FirestoreSessionStore(_Boom()).peek_hint_level("u1", "fp1") == 1

    def test_commit_swallows_errors(self):
        from session_store import FirestoreSessionStore

        class _Boom:
            def collection(self, _name):
                raise TimeoutError("deadline exceeded")

        # Must not raise into the request path.
        FirestoreSessionStore(_Boom()).commit_hint_level("u1", "fp1", 2)


class TestInMemoryCurrentHintLevel:
    def _store(self):
        from session_store import InMemorySessionStore
        return InMemorySessionStore()

    def test_first_call_is_level_one(self):
        assert self._store().current_hint_level("u1", "fp1") == 1

    def test_does_not_advance_the_level(self):
        store = self._store()
        store.next_hint_level("u1", "fp1")  # -> 1
        store.next_hint_level("u1", "fp1")  # -> 2
        assert store.current_hint_level("u1", "fp1") == 2
        assert store.current_hint_level("u1", "fp1") == 2

    def test_next_call_still_advances_afterwards(self):
        store = self._store()
        store.next_hint_level("u1", "fp1")
        store.current_hint_level("u1", "fp1")
        assert store.next_hint_level("u1", "fp1") == 2

    def test_first_current_call_consumes_level_one(self):
        # Asking without editing still uses up level 1, so the next real
        # attempt escalates to 2 rather than repeating the opening question.
        store = self._store()
        assert store.current_hint_level("u1", "fp1") == 1
        assert store.next_hint_level("u1", "fp1") == 2

    def test_is_scoped_per_user_and_fingerprint(self):
        store = self._store()
        store.next_hint_level("u1", "fp1")
        store.next_hint_level("u1", "fp1")
        assert store.current_hint_level("u2", "fp1") == 1
        assert store.current_hint_level("u1", "fp2") == 1

    def test_reset_clears_it(self):
        store = self._store()
        store.next_hint_level("u1", "fp1")
        store.next_hint_level("u1", "fp1")
        store.reset("u1")
        assert store.current_hint_level("u1", "fp1") == 1

    def test_respects_the_entry_bound(self):
        from session_store import InMemorySessionStore
        store = InMemorySessionStore(max_entries=5)
        for i in range(50):
            store.current_hint_level("u1", f"fp{i}")
        assert len(store._levels) == 5
