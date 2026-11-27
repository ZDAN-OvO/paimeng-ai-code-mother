package com.zdan.paimengaicodemother.cutover;

import com.zdan.paimengaicodemother.exception.BusinessException;
import org.aspectj.lang.ProceedingJoinPoint;
import org.aspectj.lang.annotation.Around;
import org.aspectj.lang.annotation.Aspect;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;

@Aspect
@Component
@Order(0)
public class WriteAdmissionAspect {
    private final WriteBarrier barrier;

    public WriteAdmissionAspect(WriteBarrier barrier) {
        this.barrier = barrier;
    }

    @Around("@annotation(com.zdan.paimengaicodemother.cutover.CutoverWrite)")
    public Object admit(ProceedingJoinPoint joinPoint) throws Throwable {
        String operation = joinPoint.getSignature().getDeclaringType().getSimpleName()
                + "." + joinPoint.getSignature().getName();
        try (var ticket = barrier.begin(operation)) {
            try {
                return joinPoint.proceed();
            } catch (BusinessException error) {
                throw error;
            } catch (Throwable error) {
                ticket.fail(error);
                throw error;
            }
        }
    }
}
