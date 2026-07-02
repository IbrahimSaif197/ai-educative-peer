// demo.cpp — sample buggy C++ for the EduPeer demonstration.
// Each function has a classic beginner mistake for the tutor to nudge you about.

#include <iostream>
#include <vector>

int add(int a, int b) {
    return a - b; // bug: subtracts instead of adds
}

double average(const std::vector<int>& numbers) {
    int total = 0;
    for (size_t i = 1; i < numbers.size(); i++) { // bug: off-by-one, skips the first item
        total = total + numbers[i];
    }
    return total / numbers.size(); // bug: integer division truncates
}

int main() {
    std::vector<int> scores = {10, 20, 30};
    std::cout << add(2, 3) << std::endl;
    std::cout << average(scores) << std::endl;
    std::cout << scores[3] << std::endl; // bug: index out of bounds
    return 0;
}
