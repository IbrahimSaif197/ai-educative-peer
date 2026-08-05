```python
def average(numbers):
    total = 0
    for i in range(len(numbers) + 1):
        total += numbers[i]
    return total / len(numbers)
```

EduPeer reads whatever file you have open and flags the lines worth a second
look. It will not rewrite this function for you.
