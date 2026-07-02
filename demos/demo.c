/* demo.c — sample buggy C for the EduPeer demonstration.
   Each function has a classic beginner mistake for the tutor to nudge you about. */

#include <stdio.h>

int add(int a, int b) {
    return a - b; /* bug: subtracts instead of adds */
}

double average(int numbers[], int count) {
    int total = 0;
    for (int i = 1; i < count; i++) { /* bug: off-by-one, skips the first item */
        total = total + numbers[i];
    }
    return total / count; /* bug: integer division truncates */
}

int main(void) {
    int scores[3] = {10, 20, 30};
    int x; /* bug: used uninitialized below */
    printf("%d\n", add(2, 3));
    printf("%f\n", average(scores, 3));
    printf("%d\n", x + 1);
    return 0;
}
