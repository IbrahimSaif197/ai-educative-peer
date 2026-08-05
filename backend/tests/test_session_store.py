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
