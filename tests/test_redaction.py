from rag.redact import REDACTED, redact


def test_aadhaar_with_and_without_spaces():
    assert redact("my aadhaar is 1234 5678 9012")[0] == f"my aadhaar is {REDACTED}"
    assert redact("my aadhaar is 123456789012")[0] == f"my aadhaar is {REDACTED}"
    assert redact("id 1234-5678-9012 ok")[0] == f"id {REDACTED} ok"


def test_epic_mobile_email():
    text, changed = redact("EPIC ABC1234567, call 9876543210 or +91 98765 43210, mail a.b@example.com")
    assert changed
    assert "ABC1234567" not in text
    assert "9876543210" not in text
    assert "98765 43210" not in text
    assert "a.b@example.com" not in text
    assert text.count(REDACTED) == 4


def test_procedural_text_is_untouched():
    for text in [
        "How do I fill Form 6B?",
        "The fee is Rs. 75 and takes 90 days",
        "Photograph 4.5cm X 3.5cm, PIN 110001",
        "Section 31 of the Representation of People Act, 1950",
    ]:
        assert redact(text) == (text, False)
