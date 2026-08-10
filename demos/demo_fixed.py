def add(a, b):
    return a + b


def average(numbers):
    if not numbers:
        raise ValueError("average() needs at least one number")
    total = 0
    for number in numbers:
        total = total + number
    return total / len(numbers)


def find_max(numbers):
    if not numbers:
        raise ValueError("find_max() needs at least one number")

    biggest = numbers[0]
    for number in numbers[1:]:
        if number > biggest:
            biggest = number
    return biggest


if __name__ == "__main__":
    print(add(2, 3))                    # 5
    print(average([10, 20, 30]))        # 20.0
    print(find_max([-5, -2, -9]))       # -2

    for label, call in (
        ("average([])", lambda: average([])),
        ("find_max([])", lambda: find_max([])),
    ):
        try:
            call()
        except ValueError as exc:
            print(f"{label} -> ValueError: {exc}")
