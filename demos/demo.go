package main

import "fmt"

// EduPeer demo: this Go file contains a couple of beginner bugs.

func average(numbers []int) int {
	sum := 0
	for i := 0; i <= len(numbers); i++ {
		sum += numbers[i]
	}
	return sum / len(numbers)
}

func main() {
	scores := []int{90, 85, 77}
	fmt.Println("average:", average(scores))
}
