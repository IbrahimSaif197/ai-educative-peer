"""Registry of programming languages EduPeer can tutor.

Keys are VS Code languageIds so the extension can pass
`document.languageId` straight through.
"""

from typing import Dict, List

# Concepts that apply to every language the tutor supports.
BASE_CONCEPTS: List[str] = [
    "variables", "loops", "for-loop", "while-loop", "conditionals",
    "if-statement", "functions", "recursion", "strings", "arrays",
    "indexing", "classes", "objects", "inheritance", "scope", "booleans",
    "operators", "input-output", "syntax-error", "off-by-one",
    "type-error", "return-value", "nesting", "comparison",
]

LANGUAGES: Dict[str, dict] = {
    "python": {
        "display_name": "Python",
        "fence": "python",
        "concepts": [
            "lists", "dictionaries", "tuples", "sets", "slicing",
            "exceptions", "file-io", "imports", "mutability", "iterators",
            "comprehensions", "lambdas", "decorators", "generators",
            "typing", "indentation", "name-error", "index-error",
            "key-error", "attribute-error",
        ],
    },
    "javascript": {
        "display_name": "JavaScript",
        "fence": "javascript",
        "concepts": [
            "let-const-var", "closures", "callbacks", "promises",
            "async-await", "arrow-functions", "equality", "undefined",
            "null", "hoisting", "template-literals", "json", "semicolons",
            "array-methods",
        ],
    },
    "java": {
        "display_name": "Java",
        "fence": "java",
        "concepts": [
            "interfaces", "packages", "static", "access-modifiers",
            "null-pointer", "arraylist", "generics", "casting",
            "main-method", "semicolons", "braces", "string-comparison",
            "integer-division",
        ],
    },
    "c": {
        "display_name": "C",
        "fence": "c",
        "concepts": [
            "pointers", "memory-allocation", "segfault", "header-files",
            "printf-scanf", "format-specifiers", "null-terminator",
            "semicolons", "braces", "integer-division", "uninitialized-variable",
        ],
    },
    "cpp": {
        "display_name": "C++",
        "fence": "cpp",
        "concepts": [
            "pointers", "references", "memory-allocation", "segfault",
            "header-files", "iostream", "vectors", "templates",
            "semicolons", "braces", "integer-division", "pass-by-reference",
        ],
    },
    "csharp": {
        "display_name": "C#",
        "fence": "csharp",
        "concepts": [
            "namespaces", "properties", "interfaces", "static",
            "access-modifiers", "null-reference", "generics", "linq",
            "console-io", "semicolons", "braces", "string-comparison",
        ],
    },
}

DEFAULT_LANGUAGE = "python"

_ALIASES = {
    "py": "python",
    "js": "javascript",
    "node": "javascript",
    "typescript": "javascript",
    "typescriptreact": "javascript",
    "javascriptreact": "javascript",
    "c++": "cpp",
    "cs": "csharp",
    "c#": "csharp",
}


def normalize_language(raw: str) -> str:
    """Map any client-supplied language string to a registry key.

    Unknown or empty values fall back to Python so requests from older
    clients (which never send a language) keep working unchanged.
    """
    key = (raw or "").strip().lower()
    key = _ALIASES.get(key, key)
    return key if key in LANGUAGES else DEFAULT_LANGUAGE


def get_language(raw: str) -> dict:
    return LANGUAGES[normalize_language(raw)]


def concepts_for(raw: str) -> List[str]:
    return BASE_CONCEPTS + get_language(raw)["concepts"]
