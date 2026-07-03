import pytest

from languages import (
    BASE_CONCEPTS,
    DEFAULT_LANGUAGE,
    LANGUAGES,
    concepts_for,
    get_language,
    normalize_language,
)


class TestNormalizeLanguage:
    @pytest.mark.parametrize("lang_id", list(LANGUAGES.keys()))
    def test_registry_keys_pass_through(self, lang_id):
        assert normalize_language(lang_id) == lang_id

    @pytest.mark.parametrize(
        "alias,expected",
        [
            ("js", "javascript"),
            ("ts", "typescript"),
            ("typescriptreact", "typescript"),
            ("c++", "cpp"),
            ("c#", "csharp"),
            ("cs", "csharp"),
            ("py", "python"),
            ("golang", "go"),
            ("rs", "rust"),
        ],
    )
    def test_aliases(self, alias, expected):
        assert normalize_language(alias) == expected

    def test_typescript_is_first_class(self):
        assert normalize_language("typescript") == "typescript"

    def test_case_and_whitespace_insensitive(self):
        assert normalize_language("  Java ") == "java"
        assert normalize_language("CPP") == "cpp"

    @pytest.mark.parametrize("raw", ["", None, "ruby", "brainfuck"])
    def test_unknown_falls_back_to_default(self, raw):
        assert normalize_language(raw) == DEFAULT_LANGUAGE


class TestRegistry:
    def test_supports_at_least_ten_languages(self):
        assert len(LANGUAGES) >= 10
        for lang_id in ("typescript", "go", "rust", "sql"):
            assert lang_id in LANGUAGES

    @pytest.mark.parametrize("lang_id", list(LANGUAGES.keys()))
    def test_entries_are_complete(self, lang_id):
        entry = LANGUAGES[lang_id]
        assert entry["display_name"]
        assert entry["fence"]
        assert isinstance(entry["concepts"], list)

    def test_concepts_for_includes_base_and_language_specific(self):
        c_concepts = concepts_for("c")
        for base in BASE_CONCEPTS:
            assert base in c_concepts
        assert "pointers" in c_concepts
        assert "comprehensions" not in c_concepts  # python-only

    def test_get_language_display_names(self):
        assert get_language("cpp")["display_name"] == "C++"
        assert get_language("csharp")["display_name"] == "C#"
