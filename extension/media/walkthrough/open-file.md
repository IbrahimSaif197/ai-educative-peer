```python
def average(numbers):
    total = 0
    for i in range(len(numbers) + 1):
        total += numbers[i]
    return total / len(numbers)
```

Rest your cursor in a function and EduPeer looks at that function — not the
whole file, and not until you land somewhere. It flags the lines worth a
second look. It will not rewrite this one for you.
