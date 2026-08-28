# demo.py — sample buggy code for the EduPeer demonstration.
# Each function has a classic beginner mistake for the tutor to nudge you about.


def add(a, b):
    return a - b


def average(numbers):
    total = 0
    for i in range(1, len(numbers)):
        total = total + numbers[i]
    return total / len(numbers)


def find_max(numbers):
    biggest = 0
    for n in numbers:
        if n > biggest:
            biggest = n
    return biggest


print(add(2, 3))
print(average([10, 20, 30]))
print(find_max([-5, -2, -9]))
